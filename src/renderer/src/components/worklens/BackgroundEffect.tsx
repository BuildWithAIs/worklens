import { type CSSProperties, useEffect, useRef, useState } from "react";
import type { Settings } from "../../../../shared/contracts";
import { backgroundShader } from "./background-shader";
import { nightShader } from "./background-night-shader";
import "./background-effect.css";

// Shader branch for each effect; keep in sync with background-shader.ts.
const shapes = {
  fluid: 0,
  surface: 1,
  aurora: 2,
  silk: 3,
  caustics: 4,
  nebula: 5,
} as const;

export function useDarkAppearance(settings: Settings) {
  const [systemDark, setSystemDark] = useState(
    () => matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const change = () => setSystemDark(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return (
    settings.theme === "dark" || (settings.theme === "system" && systemDark)
  );
}

export function BackgroundEffect({
  settings,
  intensity,
}: {
  settings: Settings;
  intensity?: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const dark = useDarkAppearance(settings);
  const effect = settings.backgroundEffect ?? "none";
  const tone = settings.backgroundTone ?? "violet";
  const amount =
    intensity ??
    (effect === "none" ? 50 : (settings.backgroundIntensity?.[effect] ?? 50));
  const strength = useRef(amount / 50);
  const redraw = useRef<(() => void) | null>(null);
  useEffect(() => {
    strength.current = amount / 50;
    redraw.current?.();
  }, [amount]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || effect === "none") return;
    setFailed(false);
    const gl = element.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      setFailed(true);
      return;
    }
    const shaders: WebGLShader[] = [];
    const program = gl.createProgram()!;
    const buffer = gl.createBuffer();
    const release = () => {
      shaders.forEach((shader) => gl.deleteShader(shader));
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
    try {
      for (const [type, source] of [
        [
          gl.VERTEX_SHADER,
          "attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}",
        ],
        [gl.FRAGMENT_SHADER, dark ? nightShader : backgroundShader],
      ] as const) {
        const shader = gl.createShader(type)!;
        shaders.push(shader);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
          throw new Error("shader");
        gl.attachShader(program, shader);
      }
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("program");
    } catch {
      release();
      setFailed(true);
      return;
    }
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    );
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const uniforms = Object.fromEntries(
      ["resolution", "time", "tone", "shape", "dark", "strength"].map((key) => [
        key,
        gl.getUniformLocation(program, key),
      ]),
    );
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0,
      time = 12,
      last = 0,
      visible = true,
      lost = false;
    const draw = () => {
      if (lost) return;
      gl.viewport(0, 0, element.width, element.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(uniforms.resolution, element.width, element.height);
      gl.uniform1f(uniforms.time, time);
      gl.uniform1f(
        uniforms.tone,
        { violet: 1, electric: 2, ice: 3, sunset: 4, neon: 5 }[tone],
      );
      gl.uniform1f(uniforms.shape, shapes[effect]);
      gl.uniform1f(uniforms.dark, Number(dark));
      gl.uniform1f(uniforms.strength, strength.current);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    redraw.current = draw;
    const tick = (now: number) => {
      if (now - last >= 1000 / 24) {
        time += Math.min((now - last) / 1000, 0.1);
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      if (lost || document.hidden || !visible) {
        element.dataset.motion = "paused";
        return;
      }
      draw();
      const animate = !reduced.matches;
      element.dataset.motion = animate ? "running" : "static";
      last = performance.now();
      if (animate) frame = requestAnimationFrame(tick);
    };
    const resize = new ResizeObserver(() => {
      const box = element.getBoundingClientRect();
      element.width = Math.max(1, Math.round(box.width * 0.75));
      element.height = Math.max(1, Math.round(box.height * 0.75));
      sync();
    });
    resize.observe(element);
    const intersection = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    intersection.observe(element);
    const theme = new MutationObserver(sync);
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const loss = () => {
      lost = true;
      cancelAnimationFrame(frame);
      setFailed(true);
    };
    element.addEventListener("webglcontextlost", loss);
    reduced.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
    sync();
    return () => {
      cancelAnimationFrame(frame);
      redraw.current = null;
      resize.disconnect();
      intersection.disconnect();
      theme.disconnect();
      reduced.removeEventListener("change", sync);
      document.removeEventListener("visibilitychange", sync);
      element.removeEventListener("webglcontextlost", loss);
      release();
      // StrictMode reuses this canvas after cleanup; release resources, not its context.
    };
  }, [effect, tone, dark]);
  if (effect === "none") return null;
  return (
    <div
      className="background-effect"
      data-intensity={amount}
      style={{ "--background-strength": amount / 50 } as CSSProperties}
      data-tone={tone}
      data-fallback={failed || undefined}
      aria-hidden="true"
    >
      <canvas key={effect + tone} ref={canvas} />
    </div>
  );
}
