// Errors whose message is written for a human and is safe to render in the
// UI. Anything else (DOMExceptions from WebRTC, TypeErrors, …) is an internal
// failure and gets replaced with a generic message instead of being shown raw.
export class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}
