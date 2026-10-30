export const KINDS = ["permission", "question", "completed", "aborted", "failed"] as const;
export type NotificationKind = (typeof KINDS)[number];
export type Outcome = "completed" | "aborted" | "error";
export const SYSTEM_SOUNDS = ["Asterisk", "Beep", "Exclamation", "Hand", "Question"] as const;
export type SystemSound = (typeof SYSTEM_SOUNDS)[number];
export const TITLE_LIMIT = 128;
export const MESSAGE_LIMIT = 512;
export interface ToastConfig { enabled: boolean; title: string; message: string }
export const SOUND_PATH_LIMIT = 1024;
export const VOLUME_MIN = 0;
export const VOLUME_MAX = 1;
export type SoundSource = { type: "system"; name: SystemSound } | { type: "file"; path: string };
/** volume is a linear amplitude gain (0 = silent, 1 = original level), applied to file sounds only. */
export interface SoundConfig { enabled: boolean; volume: number; source: SoundSource }
export interface NotificationPayload { kind: NotificationKind; toast: ToastConfig; sound: SoundConfig }
/** Limits single-line XML text; quotes and XML characters are preserved and encoded safely by the DOM. */
export function validText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit &&
    !/[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffe\uffff\ud800-\udfff]/u.test(value);
}
export function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}
/** Accepts only absolute WAV paths on ordinary disks; environment variables, home directories, and project-relative paths are not expanded. */
export function validSoundPath(value: unknown): value is string {
  if (!validText(value, SOUND_PATH_LIMIT) || !/^[a-z]:[\\/]/iu.test(value) ||
      /[<>:"|?*]/u.test(value.slice(2)) || !/\.wav$/iu.test(value)) return false;
  return value.slice(3).split(/[\\/]/u).every(part => part.length > 0 && !/[. ]$/u.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(part));
}
/** Volume must be a finite number in 0-1; NaN, Infinity, and strings are rejected. */
export function validVolume(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= VOLUME_MIN && value <= VOLUME_MAX;
}
export function validSoundSource(value: unknown): value is SoundSource {
  if (!isRecord(value)) return false;
  return value.type === "system"
    ? onlyKeys(value, ["type", "name"]) && SYSTEM_SOUNDS.includes(value.name as SystemSound)
    : value.type === "file" && onlyKeys(value, ["type", "path"]) && validSoundPath(value.path);
}
export function validPayload(value: unknown): value is NotificationPayload {
  if (!isRecord(value) || !onlyKeys(value, ["kind", "toast", "sound"]) ||
      !KINDS.includes(value.kind as NotificationKind) || !isRecord(value.toast) || !isRecord(value.sound)) return false;
  const { toast, sound } = value;
  return onlyKeys(toast, ["enabled", "title", "message"]) && typeof toast.enabled === "boolean" &&
    validText(toast.title, TITLE_LIMIT) && validText(toast.message, MESSAGE_LIMIT) &&
    onlyKeys(sound, ["enabled", "volume", "source"]) && typeof sound.enabled === "boolean" &&
    validVolume(sound.volume) && validSoundSource(sound.source) &&
    (toast.enabled || sound.enabled);
}
export interface NotificationJob {
  key: string;
  kind: NotificationKind;
  /** Re-confirms that the event is still valid before submission; no job content is kept. */
  valid(): boolean;
}
export interface NotificationSink {
  enqueue(job: NotificationJob): void;
  cancel(key: string): void;
}
export type Diagnostic = (code: string) => void;
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}
