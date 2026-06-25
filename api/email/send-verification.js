const { handleEmailRoute } = require('../../server/email-route.cjs');

module.exports = async (req, res) => {
  await handleEmailRoute(req, res);
};
