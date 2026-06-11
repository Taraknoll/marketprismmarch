// Retired 2026-06-11: the V2 design-test page graduated into the main
// dashboard's Daily Plays tab. Anyone holding the old /daily-v2 URL lands
// on the dashboard.
module.exports = (req, res) => {
  res.statusCode = 308;
  res.setHeader('Location', '/dashboard');
  res.end();
};
