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

// Serves Insights with a saved summary, so its card shows the footer.
export async function mockSummary(page) {
  await page.addInitScript(() => {
    const usage = (total) => ({
      status: "complete",
      input: total,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total,
      cost: { status: "unavailable", source: "unknown" },
    });
    const day = "2026-10-28";
    const model = { provider: "deepseek", model: "flash" };
    const overview = {
      range: { start: day, end: day },
      scope: "retained-local-sessions",
      retainedSessions: 1,
      unreadableSessions: 0,
      usage: usage(400000),
      granularity: "day",
      trend: [{ start: day, end: day, usage: usage(400000), runs: 3 }],
      activity: Array.from({ length: 7 }, () =>
        Array.from({ length: 24 }, () => ({ tokens: 0, runs: 0 })),
      ),
      activeDays: [day],
      sessions: { created: 1, active: 1, continued: 0, runs: 3, failedRuns: 0 },
      models: [{ ...model, runs: 3, usage: usage(400000) }],
      tools: [],
      topics: [
        {
          id: "other",
          source: "other",
          tokens: 400000,
          conversationIds: ["one"],
        },
      ],
      conversations: [
        {
          id: "one",
          title: "Weekly report",
          topicId: "other",
          models: [model],
          runs: 3,
          usage: usage(400000),
          lastAt: `${day}T09:00:00Z`,
          days: [day],
        },
      ],
    };
    const invoke = window.worklens.invoke;
    window.worklens.invoke = async (method, input) => {
      if (method === "overview") return overview;
      if (method === "reportSummary")
        return {
          stale: false,
          conversations: 1,
          summary: {
            ...overview.range,
            summary: "Reviewed the reading plan.",
            highlights: ["Checked the layout"],
            themes: [],
            model,
            usage: usage(1800),
            generatedAt: `${day}T09:00:00Z`,
            fingerprint: "fixture",
          },
        };
      const result = await invoke(method, input);
      if (method === "bootstrap")
        result.settings.reportSummary = { enabled: true, models: [model] };
      return result;
    };
  });
}

function luminance(rgb) {
  return rgb.reduce((sum, channel, index) => {
    const encoded = channel / 255;
    const linear =
      encoded <= 0.04045 ? encoded / 12.92 : ((encoded + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
}

export function navigationContrast(page) {
  return textContrast(
    page,
    ".conversation-title, .settings-navigation nav button",
    ".conversation-list, .settings-navigation",
  );
}

// Measures each matching text against what is drawn under its glyphs,
// clipped to the visible part of its container.
export async function textContrast(page, selector, container) {
  const titles = await page.locator(selector).evaluateAll(
    (elements, container) =>
      elements
        .map((element) => {
          const box = element.getBoundingClientRect();
          const list = element.closest(container).getBoundingClientRect();
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
    container,
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
