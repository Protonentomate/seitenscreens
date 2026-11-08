/**
 * Hover-Vorschau für Videos: ein Filmstreifen (JPEG) aus PREVIEW_FRAMES
 * gleichmässig über die Loop verteilten Einzelbildern, nebeneinander.
 * Die Control-UI blättert ihn per CSS durch — wie ein GIF im Zeitraffer.
 * Server (ffmpeg) und UI (CSS-Animation) müssen dieselben Werte nutzen.
 */
export const PREVIEW_FRAMES = 20
/** Abspieltempo der Vorschau (Bilder pro Sekunde) → 20 Bilder = 2,5 s. */
export const PREVIEW_FPS = 8
export const PREVIEW_FRAME_W = 108
export const PREVIEW_FRAME_H = 192
