// Runtime config for the dashboard.
// The Google Apps Script Web App URL below is a public endpoint that
// reads/writes publisher follow-up status. Anyone with the URL can
// write, so keeping it in a public repo is intentional — the endpoint
// is scoped to a single Google Sheet you own and can revoke by
// re-deploying the script.
window.APP_CONFIG = {
  SHEET_API: "https://script.google.com/macros/s/AKfycbzaZNCgbxXeqoX8S7kjmPYkJltGwuYpAFpQldVztIVi9PMlZfu2Cnzx7ndnA1PN-OFf/exec",
};
