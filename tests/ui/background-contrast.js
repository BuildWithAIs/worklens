import sharp from "sharp";
import { mockWorklens } from "./fixture.js";

export async function mockBackgroundConversations(page, effect) {
  await mockWorklens(page);
  await page.addInitScript((effect) => {
    const query = new URL(location.href).searchParams;
    const intensity = Number(query.get("intensity") ?? 100);
    const time = Number(query.get("time") ?? 12);
    const selected = query.get("selected") ?? "4";
    const titles = [
      "Plan a small garden",
      "Collect library notes",
      "Sketch a paper lantern",
      "Organize a reading journal",
    ];
    const views = Array.from({ length: 18 }, (_, index) => ({
      id: `contrast-${index}`,
      title: `${titles[index % titles.length]} ${index + 1}`,
      phase: "completed",
      updatedAt: new Date(Date.UTC(2026, 0, 20 - index)).toISOString(),
      messages: [
        {
          id: `prompt-${index}`,
          role: "user",
          text: "Prepare a reading plan.",
        },
        {
          id: `reply-${index}`,
          role: "assistant",
          text: "Start with a short list.",
        },
      ],
    }));
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (method, input) => {
      if (method === "open")
        return structuredClone(views.find((view) => view.id === input.id));
      const result = await invoke(method, input);
      if (method === "bootstrap") {
        result.conversations = views;
        Object.assign(result.settings, {
          theme: "dark",
          backgroundEffect: effect,
          backgroundTone: query.get("palette") ?? "sunset",
          backgroundIntensity: { [effect]: intensity },
          lastConversation: `contrast-${selected}`,
        });
      }
      return result;
    };
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.nativeVibrancy = String(
        query.get("native") !== "0",
      );
    });
    // Sample repeatable animation phases through the real rendering path.
    const timeLocations = new WeakSet();
    const getLocation = WebGLRenderingContext.prototype.getUniformLocation;
    WebGLRenderingContext.prototype.getUniformLocation = function (
      program,
      name,
    ) {
      const location = getLocation.call(this, program, name);
      if (name === "time" && location) timeLocations.add(location);
      return location;
    };
    const uniform = WebGLRenderingContext.prototype.uniform1f;
    WebGLRenderingContext.prototype.uniform1f = function (location, value) {
      return uniform.call(
        this,
        location,
        timeLocations.has(location) ? time : value,
      );
    };
  }, effect);
}

function luminance(rgb) {
  return rgb.reduce((sum, channel, index) => {
    const encoded = channel / 255;
    const linear =
      encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

export async function navigationContrast(page) {
  const selector = ".conversation-title, .settings-navigation nav button";
  const titles = await page.locator(selector).evaluateAll((elements) =>
    elements
      .map((element) => {
        const box = element.getBoundingClientRect();
        const list = element
          .closest(".conversation-list, .settings-navigation")
          .getBoundingClientRect();
        const style = getComputedStyle(element);
        if (
          style.visibility !== "visible" ||
          !box.width ||
          box.top < Math.max(0, list.top) ||
          box.bottom > Math.min(innerHeight, list.bottom)
        )
          return null;
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = style.color;
        ctx.fillRect(0, 0, 1, 1);
        return {
          text: element.textContent,
          selected: !!element.closest(".selected, [aria-current=page]"),
          color: [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3),
          x: Math.max(box.left, list.left),
          y: Math.max(box.top, list.top),
          right: Math.min(box.right, list.right),
          bottom: Math.min(box.bottom, list.bottom),
        };
      })
      .filter(Boolean),
  );
  const visible = await sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let hidden;
  await page.locator(selector).evaluateAll((elements) =>
    elements.forEach((element) => {
      element.style.color = "transparent";
    }),
  );
  try {
    hidden = await sharp(await page.screenshot())
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  } finally {
    await page.locator(selector).evaluateAll((elements) =>
      elements.forEach((element) => {
        element.style.removeProperty("color");
      }),
    );
  }
  return titles.map((title) => {
    const foreground = luminance(title.color);
    let minimum = Infinity;
    let samples = 0;
    for (
      let y = Math.max(0, Math.ceil(title.y));
      y < Math.min(hidden.info.height, Math.floor(title.bottom));
      y++
    ) {
      for (
        let x = Math.max(0, Math.ceil(title.x));
        x < Math.min(hidden.info.width, Math.floor(title.right));
        x++
      ) {
        const offset = (y * hidden.info.width + x) * 3;
        const background = [...hidden.data.subarray(offset, offset + 3)];
        // Only evaluate backgrounds under actual glyphs, excluding whitespace.
        if (
          Math.max(
            ...background.map((value, channel) =>
              Math.abs(value - visible.data[offset + channel]),
            ),
          ) < 20
        )
          continue;
        const behind = luminance(background);
        minimum = Math.min(
          minimum,
          (Math.max(foreground, behind) + 0.05) /
            (Math.min(foreground, behind) + 0.05),
        );
        samples++;
      }
    }
    return {
      text: title.text,
      selected: title.selected,
      minimum: samples ? minimum : 0,
      samples,
    };
  });
}
