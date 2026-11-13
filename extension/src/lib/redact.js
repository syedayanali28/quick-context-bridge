// Optional redaction for sharing exports outside the team.
// Redacted exports are for reading only: the QAL can no longer be imported back as-is.

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * @param {string} text
 * @param {{awsAccountId?:string, quickAccount?:string}} ids
 */
export function redactText(text, ids = {}) {
  let t = String(text);
  if (ids.awsAccountId) t = t.split(ids.awsAccountId).join('<aws-account-id>');
  if (ids.quickAccount) t = t.split(ids.quickAccount).join('<quick-account>');
  t = t.replace(EMAIL, '<email>');
  return t;
}
