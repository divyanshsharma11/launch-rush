// A rule failure with an error code. Controllers map the code to an HTTP status;
// `fields` go into the error body (e.g. already_reserved adds orderId and state).
export class BusinessError extends Error {
  constructor(code, message, fields = {}) {
    super(message);
    this.code = code;
    this.fields = fields;
  }
}
