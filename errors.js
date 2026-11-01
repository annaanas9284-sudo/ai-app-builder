'use strict';

/** An error that is safe to show to the user, with an HTTP status. */
class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

module.exports = { ApiError };
