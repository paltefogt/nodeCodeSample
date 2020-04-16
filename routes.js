"use strict";

const trelloCardSync = require("../arnold/trello-card-sync/main");

module.exports.routes = (app) => {
  app.post("/addDeliverablesToTrello", async (req, res) => {
    const resAddDeliverables = await trelloCardSync
      .addDeliverablesAsync(req.body.deliverableIds, req.body.taxSeasonId)
      .catch((error) => {
        res.status(503).send(error);
      });
    res.send(resAddDeliverables);
  });
};
