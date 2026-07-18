// resend — outbound email SDK, stubbed. The real package pulls in postal-mime
// and needs an HTTP client; milojs has neither. Sending rejects loudly so email
// routes fail with a clear reason instead of pretending to send.
function Resend(apiKey) {
  if (!(this instanceof Resend)) return new Resend(apiKey);
  this.apiKey = apiKey;
  this.emails = {
    send: function () {
      return Promise.reject(new Error('resend: sending email is not available under milojs (no outbound HTTP)'));
    }
  };
  this.batch = { send: this.emails.send };
}
exports.Resend = Resend;
exports.default = { Resend: Resend };
