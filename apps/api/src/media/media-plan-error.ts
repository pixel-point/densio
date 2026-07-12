export class MediaPlanError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MediaPlanError";
    this.code = code;
  }
}
