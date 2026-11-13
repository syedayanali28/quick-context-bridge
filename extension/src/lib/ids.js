// Parse a Quick Automate console URL into the identifiers the backend expects.
//
// Example:
//   https://us-east-1.quicksight.aws.amazon.com/sn/account/<QuickAccount>/automations/
//     arn:aws:quicksight:us-east-1:<awsAccountId>:automation-group_<G>_automation_<A>/workflow-builder

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ARN_RE = new RegExp(
  `arn:aws:quicksight:([a-z0-9-]+):(\\d{12}):automation-group_(${UUID})_automation_(${UUID})`,
  'i',
);
const ACCOUNT_RE = /\/sn\/account\/([^/]+)\//;

/**
 * @param {string} href
 * @returns {null | {region:string, awsAccountId:string, groupId:string, automationId:string,
 *                   quickAccount:string|null, arn:string, host:string, view:string|null}}
 */
export function parseAutomationUrl(href) {
  let u;
  try { u = new URL(href); } catch { return null; }
  if (!/\.quicksight\.aws\.amazon\.com$/i.test(u.hostname)) return null;
  const path = decodeURIComponent(u.pathname);
  const m = path.match(ARN_RE);
  if (!m) return null;
  const acct = path.match(ACCOUNT_RE);
  const after = path.slice(path.indexOf(m[0]) + m[0].length).replace(/^\/+/, '');
  return {
    region: m[1],
    awsAccountId: m[2],
    groupId: m[3].toLowerCase(),
    automationId: m[4].toLowerCase(),
    quickAccount: acct ? acct[1] : null,
    arn: m[0],
    host: u.host,
    view: after.split('/')[0] || null,
  };
}

/** Filesystem-friendly slug. */
export function slugify(s, fallback = 'automation') {
  const out = String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return out || fallback;
}
