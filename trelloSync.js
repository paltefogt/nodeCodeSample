"use strict";

const async = require("async");
const fs = require("fs");

const pool = require("../../db");
const trelloInterface = require("../../trello/interface");
const trello = require("../../trello/interfaceAsync").trello;
const trelloRequestAsync = require("../../trello/interfaceAsync")
  .trelloRequestAsync;
const controller = require("controller");
const arnoldLogger = require("../logger");

const getFinancialStatementsCountQuery = fs.readFileSync(
  "./lib/sql/get_financial_statements_count.sql"
);

module.exports.addDeliverablesAsync = async (deliverableIds, taxSeasonId) => {
  // for each deliverable we sync
  // generate the trello checkitem
  // get its card: get trello_relation for entityId -> this will be the id of the trello card we need
  // if no trello_relation for entityId -> then the entity is on the main client card, get trello_relation for clientId
  // get trello_relation for deliverableId -> this will be the id of the checkitem for the deliverable
  // verify that checkitem id exists in checklist on card -> if exists then just update the checkitem
  // if not exists, then the deliverable was on a different card previously -> delete the checkitem
  // create a new checkitem in the correct list on the card
  // update the deliverable trello_relation.trello_id with the newly created checkitem id

  const boards = {};
  boards.tax_return = await getBoardTrelloRelationAsync(
    taxSeasonId,
    "tax_return"
  );

  const promisesGetDeliverableData = deliverableIds.map((di) =>
    getDeliverableDataAsync(
      deliverableId,
      taxSeasonId,
      boards[deliverableData.boardType]
    )
  );
  // we want to get each deliverable that we are syncing
  // enrich the data a bit, then return it
  const deliverablesToSync = await Promise.all(
    promisesGetDeliverableData
  ).catch((error) =>
    errorHandler(error, `Promise.all : getDeliverableDataAsync`)
  );
  const promisesSyncDeliverables = deliverablesToSync.map((deliverableData) =>
    syncDeliverableWithTrelloAsync(
      deliverableData,
      taxSeasonId,
      boards[deliverableData.boardType]
    )
  );

  await Promise.all(promisesSyncDeliverables).catch((error) => {
    errorHandler(error, `Promise.all : syncDeliverableAsync`);
  });

  return {
    numUpdatedDeliverables: deliverablesToSync.length,
  };
};

const getChecklistAsync = async (cardId, checklistName) => {
  const checklists = await trello.getChecklistsOnCard(cardId).catch((error) => {
    errorHandler(error, `getChecklistAsync : getChecklistsOnCard`);
  });
  const checklist = checklists.find((cl) => cl.name === checklistName);
  return checklist;
};

const checkitemExists = (checklist, checkitemId) => {
  return checklist.checkItems.findIndex((ci) => ci.id === checkitemId) > -1;
};

const getCheckitemName = (deliverableData) => {
  const baseUrl = `${process.env.CONTROLLER_URL}/entities/${deliverableData.deliverable.entity.id}`;
  const link = `[:newlink:](${baseUrl})`;
  const checkItemName =
    deliverableData.deliverable.entity.name +
    " (" +
    deliverableData.deliverable.getTypeDetail().name +
    ")";
  return `${link} ${checkItemName}`;
};

const getCheckitemData = (deliverableData) => {
  const checkitemName = getCheckitemName(deliverableData);
  return {
    name: checkitemName,
  };
};

const syncDeliverableWithTrelloAsync = async (deliverableData, taxSeasonId) => {
  const checkitemData = getCheckitemData(deliverableData);
  // get the appropriate checklist on the card
  const checklist = await getChecklistAsync(
    deliverableData.cardId,
    deliverableData.checklistName
  ).catch((error) => {
    errorHandler(error, `syncDeliverableWithTrelloAsync : getChecklistAsync`);
  });
  // next check if we are adding or updating a checkitem in the checklists
  if (checkitemExists(checklist, deliverableData.checkitemId)) {
    // it already exists so we can update
    const updatedCheckitem = await updateCheckitemAsync(
      deliverableData.cardId,
      deliverableData.checkitemId,
      checkitemData
    );
    await updateTrelloRelationAsync(
      deliverableData.deliverable.id,
      updatedCheckitem.id,
      taxSeasonId
    );
  } else {
    // doesn't exist, need to create
    const newCheckitem = await createCheckitemAsync(
      checklist.id,
      checkitemData,
      taxSeasonId
    );
    // since we created a new checkitem for this deliverable
    // we need to make a trello_relation for the deliverable
    await insertNewTrelloRelationAsync(
      deliverableData.deliverable.id,
      newCheckitem.id,
      taxSeasonId,
      "deliverable",
      deliverableData.boardType
    );
  }
};

const updateCheckitemAsync = async (cardId, checkitemId, checkitemData) => {
  const path = `/cards/${cardId}/checkItem/${checkitemId}`;
  return await trelloRequestAsync("put", path, null, checkitemData);
};

const createCheckitemAsync = async (checklistId, checkitemData) => {
  const path = `/checklists/${checklistId}/checkItems`;
  return await trelloRequestAsync("post", path, null, checkitemData);
};

const getNewClientCardIdMembers = (clientRank) => {
  const ranks = [
    "563a5c567090668dd0965de3",
    "563a5d50104f963795624277",
    "563a5defb13bdba98c89aac3",
    "563a5d50104f963795624277",
  ];
  const idx = ranks.findIndex((id) => id === clientRank);
  return idx > -1 ? ranks[idx] : "563a5d50104f963795624277";
};

const createNewClientCardAsync = async (
  deliverableData,
  taxSeasonId,
  board
) => {
  const client = deliverableData.deliverable.entity.client;
  const pba = client.pbas[taxSeasonId];
  const listToCreateCardsInName =
    trelloInterface.boardOptions["Tax Year"].listToCreateCardsIn;
  const listToCreateCardsInId = board.lists.find((list) =>
    list.name.includes(listToCreateCardsInName)
  ).id;

  const referenceBoard = await getReferenceBoardAsync().catch((error) => {
    errorHandler(error, `trelloInterface.referenceBoardAsync`);
  });
  const listTemplates = referenceBoard.lists.find(
    (list) => (list.name = "Templates")
  );

  const templateCards = await trello.getCardsForList(listTemplates.id);

  const desc = createInitialDescriptionLinks(
    client.id,
    process.env.CONTROLLER_URL
  );
  const idCardSource = templateCards.find((card) => card.name === "Tax Year")
    .id;
  const idLabels = board.labels.find(
    (label) => label.name === `${pba.firstName} ${pba.lastName}`
  ).id;
  const idMembers = getNewClientCardIdMembers(client.rank);
  const newClientCardData = {
    desc: desc,
    idCardSource: idCardSource,
    idLabels: idLabels,
    idList: listToCreateCardsInId,
    idMembers: idMembers,
    keepFromSource: "checklists",
    name: `${client.lastName}, ${client.firstName}`,
  };
  const newCard = await trelloRequestAsync(
    "post",
    "/cards",
    newClientCardData,
    null
  );
  await insertNewTrelloRelationAsync(
    client.id,
    newCard.id,
    taxSeasonId,
    "client",
    deliverableData.boardType
  );
  return newCard.id;
};

const getReferenceBoardAsync = async () => {
  return await getBoardDetailsAsync("568d13d6f36a676271a47aaa");
};

const updateTrelloRelationAsync = async (
  controllerId,
  trelloId,
  taxSeasonId
) => {
  const sqlUpdateTrelloRelation = `UPDATE trello_relations
	SET trello_id='${trelloId}'
	WHERE controller_id = '${controllerId} 
	AND tax_season_id = '${taxSeasonId}';`;
  await pool.query(sqlUpdateTrelloRelation).catch((error) => {
    errorHandler(error, `updateTrelloRelationAsync : sqlUpdateTrelloRelation`);
  });
};

const insertNewTrelloRelationAsync = async (
  controllerId,
  trelloId,
  taxSeasonId,
  type,
  boardType
) => {
  const sqlInsertNewClientTrelloRelation = `INSERT INTO trello_relations (controller_id, trello_id, tax_season_id, type, board_type) 
	VALUES ($1::uuid, $2, $3::uuid, $4, $5)`;
  const queryValues = [controllerId, trelloId, taxSeasonId, type, boardType];
  await pool
    .query(sqlInsertNewClientTrelloRelation, queryValues)
    .catch((error) => {
      errorHandler(
        error,
        `insertNewTrelloRelationAsync : sqlInsertNewClientTrelloRelation`
      );
    });
};

const createInitialDescriptionLinks = (clientId, controllerUrl) => {
  arnoldLogger.log("INFO", `Creating Deliverable links`);
  const clientURL = `${controllerUrl}/clients/${clientId}`;
  const clientLink = `[:newLink:](${clientURL}) - View Client\n`;

  const sendReturnsURL = `${controllerUrl}/clients/${clientId}?sendReturns=true`;
  const sendReturnsLink = `[:newLink:](${sendReturnsURL}) - Who to Send Returns to`;

  const descriptionText = clientLink + sendReturnsLink;
  return descriptionText;
};

const getBoardTrelloRelationAsync = async (taxSeasonId, boardType) => {
  const sqlSelectTrelloRelationBoard = `SELECT * FROM trello_relations 
	WHERE controller_id = '${taxSeasonId}' 
	AND type = 'board' AND board_type = '${boardType}' AND archived IS NULL`;
  const pgResSelectTrelloRelationBoard = await pool
    .query(sqlSelectTrelloRelationBoard)
    .catch((error) => {
      errorHandler(error, `sqlSelectTrelloRelationBoard : ${error}`);
    });
  if (pgResSelectTrelloRelationBoard.rows.length > 0) {
    const boardId = pgResSelectTrelloRelationBoard.rows[0].trello_id;
    if (boardId != null) {
      return await getBoardDetailsAsync(boardId);
    }
  }
};

const getBoardDetailsAsync = async (boardId) => {
  const path = `/1/boards/${boardId}`;
  const board = await trello.makeRequest("get", path).catch((error) => {
    errorHandler(error, `Error : getBoardDetailsAsync : getBoard`);
  });
  board.lists = await trello.getListsOnBoard(boardId).catch((error) => {
    errorHandler(error, `Error : getBoardDetailsAsync : getListsOnBoard`);
  });
  board.labels = await trello.getLabelsForBoard(boardId).catch((error) => {
    errorHandler(error, `Error : getBoardDetailsAsync : getLabelsForBoard`);
  });
  return board;
};

const getBoardType = (deliverableTypeName) => {
  return deliverableTypeName === "Tax Return"
    ? "tax_return"
    : "financial_statements";
};

const getChecklistName = (boardType) => {
  return boardType === "tax_return"
    ? trelloInterface.boardOptions["Tax Year"].primaryChecklistName
    : trelloInterface.boardOptions["Financial Statements"].primaryChecklistName;
};

const getDeliverableDataAsync = async (deliverableId, taxSeasonId, board) => {
  const deliverableData = {};

  // grab the deliverable
  const resDeliverable = await controller.models.allObjects
    .getDeliverablesAsync(deliverableId, null, null, taxSeasonId)
    .catch((error) => {
      errorHandler(
        error,
        `getDeliverablesAsync : deliverableId: ${deliverableId}`
      );
    });
  const deliverable = resDeliverable[0];
  // somehow the deliverable did not exist - check the deliverables tax_season?
  if (!deliverable) {
    return Promise.reject(`No deliverable found for id ${deliverableId}`);
  }
  deliverable.entity.client.fullName = deliverable.entity.client.getFullName();
  deliverable.deliverableTypeDetailName = deliverable.getTypeDetail().name;

  deliverableData.deliverable = deliverable;
  deliverableData.deliverableType = deliverable.getType();
  deliverableData.boardType = getBoardType(
    deliverableData.deliverableType.name
  );
  deliverableData.checklistName = getChecklistName(deliverableData.boardType);
  deliverableData.checkitemId = await getTrelloRelationForTaxSeasonAsync(
    deliverableId,
    "deliverable",
    deliverableData.boardType,
    taxSeasonId
  ).catch((error) => {
    errorHandler(error, `getDeliverableDataAsync`);
  });
  deliverableData.cardId = await getCardIdAsync(
    deliverableData,
    taxSeasonId,
    board
  ).catch((error) => {
    errorHandler(error, `getDeliverableDataAsync : getCardIdAsync`);
  });

  return deliverableData;
};

const getCardIdAsync = async (deliverableData, taxSeasonId, board) => {
  // let's find the id of the card we are adding the deliverable
  // we can look in trello_relations where controller_id = entityId
  // this will come back with something if the entity is split out on a card
  // that is not the regular client card
  let cardId = null;
  const entityId = deliverableData.deliverable.entity.id;
  cardId = await getTrelloRelationForTaxSeasonAsync(
    entityId,
    "split_card",
    deliverableData.boardType,
    taxSeasonId
  ).catch((error) => {
    errorHandler(error, `getCardIdAsync : get entity trello_relation`);
  });
  if (!cardId) {
    // if we get here, then presumably the entity is not on a split card
    // it is on the regular client card
    console.log(
      `No trello_relation found for entityId: ${entityId}, let's check for the client card.`
    );
    const clientId = deliverableData.deliverable.entity.client.id;
    cardId = await getTrelloRelationForTaxSeasonAsync(
      clientId,
      "client",
      deliverableData.boardType,
      taxSeasonId
    ).catch((error) => {
      errorHandler(error, `getCardIdAsync : get client trello_relation`);
    });

    // if we don't have a regular client card, then we need to make one
    if (!cardId) {
      cardId = await createNewClientCardAsync(
        deliverableData,
        taxSeasonId,
        board
      ).catch((error) => {
        errorHandler(error, `getCardIdAsync`);
      });
    }
  }
  return cardId;
};

const getTrelloRelationForTaxSeasonAsync = async (
  controllerId,
  type,
  boardType,
  taxSeasonId
) => {
  const sqlSelectTrelloRelation = `SELECT trello_id FROM trello_relations 
	WHERE controller_id = '${controllerId}' 
	AND tax_season_id = '${taxSeasonId}' 
	AND board_type = '${boardType}'
	AND type = '${type}' AND archived IS NULL`;
  const pgResSelectTrelloRelation = await pool
    .query(sqlSelectTrelloRelation)
    .catch((error) => {
      errorHandler(
        error,
        `getTrelloRelationForTaxSeason : No trello_relation found for deliverable id: ${deliverableId}`
      );
    });
  return pgResSelectTrelloRelation.rows.length === 0
    ? null
    : pgResSelectTrelloRelation.rows[0].trello_id;
};

const errorHandler = (error, msg) => {
  console.log(`Error : ${msg} : ${error}`);
};

/*
	This is the old Trello Sync function. I am leaving it here as a lesson on lousy asynchronous code
	Gaze upon the horror of callback hell!!!1!
*/
module.exports.addDeliverables = (
  deliverables,
  taxSeasonId,
  responseCallback
) => {
  controller.models.allObjects.getDeliverables((err, allDeliverables) => {
    if (err) {
      responseCallback(err);
    } else {
      let allDeliverablesById = {};
      let clientIdsTaxReturns = {};
      let clientIdsFinancialStatements = {};
      let boardTaxReturns;
      let boardFinancialStatements;
      let multipleCardClients = [];
      let numSkippedDeliverables = 0;
      let numUpdatedDeliverables = 0;
      let existingDeliverables = [];

      allDeliverables.forEach((del) => {
        allDeliverablesById[del.id] = del;
      });

      async.series(
        [
          (callback) => {
            async.each(
              deliverables,
              (deliverableId, callback) => {
                arnoldLogger.log("INFO", `For deliverableId: ${deliverableId}`);
                const queryText =
                  "SELECT * FROM trello_relations WHERE controller_id = $1 AND type = 'deliverable' AND archived IS NULL";
                const queryValues = [deliverableId];
                pool.query(queryText, queryValues, (err, result) => {
                  if (err) {
                    callback(err);
                  } else {
                    if (result.rows.length === 0) {
                      const deliverable = allDeliverablesById[deliverableId];
                      const deliverableType = deliverable.getType();

                      // assign some model parameters for functions we wont have at the client side
                      deliverable.entity.client.fullName = deliverable.entity.client.getFullName();
                      deliverable.deliverableTypeDetailName = deliverable.getTypeDetail().name;

                      if (deliverableType.name === "Tax Return") {
                        if (
                          clientIdsTaxReturns[deliverable.entity.client.id] ===
                          undefined
                        ) {
                          clientIdsTaxReturns[
                            deliverable.entity.client.id
                          ] = [];
                        }
                        clientIdsTaxReturns[deliverable.entity.client.id].push(
                          deliverable
                        );
                      } else if (
                        deliverableType.name === "Financial Statements"
                      ) {
                        if (
                          clientIdsFinancialStatements[
                            deliverable.entity.client.id
                          ] === undefined
                        ) {
                          clientIdsFinancialStatements[
                            deliverable.entity.client.id
                          ] = [];
                        }
                        clientIdsFinancialStatements[
                          deliverable.entity.client.id
                        ].push(deliverable);
                      }
                      callback();
                    } else {
                      existingDeliverables.push(
                        allDeliverablesById[deliverableId]
                      );
                      callback();
                    }
                  }
                });
              },
              (err) => {
                if (err) {
                  callback(err);
                } else {
                  callback();
                }
              }
            );
          },
          (callback) => {
            const queryText =
              "SELECT * FROM trello_relations WHERE controller_id = $1 AND type = 'board' AND board_type = 'tax_return' AND archived IS NULL";
            const queryValues = [taxSeasonId];
            pool.query(queryText, queryValues, (err, result) => {
              if (err) {
                callback(err);
              } else {
                if (result.rows.length !== 0) {
                  const boardId = result.rows[0].trello_id;
                  if (boardId != null) {
                    trelloInterface.getBoardDetails(boardId, (result) => {
                      boardTaxReturns = result;
                      callback();
                    });
                  } else {
                    callback();
                  }
                } else {
                  // board doesn't exist; thats fine
                  callback();
                }
              }
            });
          },
          (callback) => {
            const queryText =
              "SELECT * FROM trello_relations WHERE controller_id = $1 AND type = 'board' AND board_type = 'financial_statements' AND archived IS NULL";
            const queryValues = [taxSeasonId];
            pool.query(queryText, queryValues, (err, result) => {
              if (err) {
                callback(err);
              } else {
                if (result.rows.length !== 0) {
                  const boardId = result.rows[0].trello_id;
                  if (boardId != null) {
                    trelloInterface.getBoardDetails(boardId, (result) => {
                      boardFinancialStatements = result;
                      callback();
                    });
                  } else {
                    callback();
                  }
                } else {
                  // board doesn't exist; thats fine
                  callback();
                }
              }
            });
          },
          (callback) => {
            const combinedClientIds = [
              {
                boardType: "tax_return",
                deliverables: clientIdsTaxReturns,
                board: boardTaxReturns,
              },
              {
                boardType: "financial_statements",
                deliverables: clientIdsFinancialStatements,
                board: boardFinancialStatements,
              },
            ];
            async.each(
              combinedClientIds,
              (clientIds, callback) => {
                if (clientIds.board === undefined) {
                  // board doesn't exist yet for this tax season. let's not do anything!
                  callback();
                } else {
                  if (
                    Object.entries(clientIds.deliverables).length === 0 &&
                    clientIds.deliverables.constructor === Object
                  ) {
                    arnoldLogger.log(
                      "ERROR",
                      `For some reason clientIds.deliverables is empty`
                    );
                    //callback(`For some reason clientIds.deliverables is empty`);
                  }
                  async.each(
                    Object.keys(clientIds.deliverables),
                    (clientId, callback) => {
                      const queryText =
                        "SELECT * FROM trello_relations WHERE controller_id = $1 AND type = 'client' AND board_type = $2 AND tax_season_id = $3 AND archived IS NULL";
                      const queryValues = [
                        clientId,
                        clientIds.boardType,
                        taxSeasonId,
                      ];
                      let newClientCard = false;
                      pool.query(queryText, queryValues, (err, result) => {
                        if (err) {
                          callback(err);
                        } else {
                          if (result.rows.length > 1) {
                            // need user confirmation on which card to use
                            let trelloCards = [];
                            async.each(
                              result.rows,
                              (row, callback) => {
                                trelloInterface.getCard(
                                  row.trello_id,
                                  {},
                                  (data) => {
                                    trelloCards.push({
                                      id: row.trello_id,
                                      name: data.name,
                                    });
                                    callback();
                                  }
                                );
                              },
                              (err) => {
                                if (err) {
                                  callback(err);
                                } else {
                                  const d = {
                                    clientId: clientId,
                                    trelloCards: trelloCards,
                                    deliverables:
                                      clientIds.deliverables[clientId],
                                  };
                                  multipleCardClients.push(d);
                                  callback();
                                }
                              }
                            );
                          } else {
                            let card;
                            async.series(
                              [
                                (callback) => {
                                  if (result.rows.length === 0) {
                                    // no card exists, create one before making the deliverable checkitems
                                    newClientCard = true;
                                    const client =
                                      clientIds.deliverables[clientId][0].entity
                                        .client;
                                    const pba = client.pbas[taxSeasonId];
                                    const board = clientIds.board;

                                    const clientObj = {
                                      name:
                                        client.lastName +
                                        ", " +
                                        client.firstName,
                                      idLabel:
                                        board.labels[
                                          pba.firstName + " " + pba.lastName
                                        ].id,
                                    };
                                    if (client.rank === 0) {
                                      client.idMembers = "@1234";
                                    } else if (client.rank === 1) {
                                      client.idMembers = "1234";
                                    } else if (client.rank === 2) {
                                      client.idMembers = "1234";
                                    } else {
                                      client.idMembers = "1234";
                                    }

                                    arnoldLogger.log(
                                      "INFO",
                                      `Creating Deliverable links`
                                    );
                                    const clientURL = `${process.env.CONTROLLER_URL}/clients/${client.id}`;
                                    const sendReturnsURL = `${process.env.CONTROLLER_URL}/clients/${client.id}?sendReturns=true`;
                                    const clientLink = `[:newLink:](${clientURL}) - View Client\n`;
                                    const sendReturnsLink = `[:newLink:](${sendReturnsURL}) - Who to Send Returns to`;
                                    const descriptionText =
                                      clientLink + sendReturnsLink;
                                    client.desc = descriptionText;

                                    const listToCreateCardsIn =
                                      board.lists[
                                        trelloInterface.boardOptions["Tax Year"]
                                          .listToCreateCardsIn
                                      ].id;
                                    trelloInterface.referenceBoard(
                                      (referenceBoard) => {
                                        const templateCard =
                                          referenceBoard.lists["Templates"]
                                            .cards["Tax Year"];
                                        trelloInterface.createClientCard(
                                          clientObj,
                                          listToCreateCardsIn,
                                          templateCard,
                                          (err, result) => {
                                            if (err) {
                                              callback(err);
                                            } else {
                                              card = result;

                                              const queryText =
                                                "INSERT INTO trello_relations (controller_id, trello_id, tax_season_id, board_type, type) VALUES ($1::uuid, $2, $3::uuid, $4, 'client')";
                                              const queryValues = [
                                                client.id,
                                                card.id,
                                                taxSeasonId,
                                                clientIds.boardType,
                                              ];
                                              pool.query(
                                                queryText,
                                                queryValues,
                                                (err, result) => {
                                                  if (err) throw err;

                                                  callback();
                                                }
                                              );
                                            }
                                          }
                                        );
                                      }
                                    );
                                  } else {
                                    trelloInterface.getCard(
                                      result.rows[0].trello_id,
                                      {},
                                      (result) => {
                                        if (err) {
                                          callback(err);
                                        } else {
                                          card = result;
                                          callback();
                                        }
                                      }
                                    );
                                  }
                                },

                                (callback) => {
                                  // now that we have the card, lets add deliverables to it
                                  const deliverables =
                                    clientIds.deliverables[clientId];
                                  trelloInterface.trello.get(
                                    "/1/cards/" + card.id + "/checklists",
                                    [],
                                    (err, data) => {
                                      if (err) throw err;
                                      const checklistName =
                                        clientIds.boardType === "tax_return"
                                          ? trelloInterface.boardOptions[
                                              "Tax Year"
                                            ].primaryChecklistName
                                          : trelloInterface.boardOptions[
                                              "Financial Statements"
                                            ].primaryChecklistName;

                                      async.eachSeries(
                                        data,
                                        (checklist, callback) => {
                                          let checklistId = checklist.id;
                                          async.series(
                                            [
                                              (callback) => {
                                                if (
                                                  checklist.name ===
                                                  checklistName
                                                ) {
                                                  async.each(
                                                    deliverables,
                                                    (deliverable, callback) => {
                                                      trelloInterface.addCheckItemToChecklist(
                                                        checklistId,
                                                        deliverable.entity.id,
                                                        deliverable.entity.name,
                                                        deliverable.getTypeDetail()
                                                          .name,
                                                        (err3, data3) => {
                                                          if (err3) {
                                                            callback(err3);
                                                          } else {
                                                            const queryText =
                                                              "INSERT INTO trello_relations (controller_id, trello_id, tax_season_id, board_type, type) VALUES ($1::uuid, $2, $3::uuid, $4, 'deliverable')";
                                                            const queryValues = [
                                                              deliverable.id,
                                                              data3.id,
                                                              taxSeasonId,
                                                              clientIds.boardType,
                                                            ];
                                                            pool.query(
                                                              queryText,
                                                              queryValues,
                                                              (err, result) => {
                                                                if (err) {
                                                                  callback(err);
                                                                } else {
                                                                  numUpdatedDeliverables++;
                                                                  callback();
                                                                }
                                                              }
                                                            );
                                                          }
                                                        }
                                                      );
                                                    },
                                                    (err) => {
                                                      if (err) {
                                                        callback(err);
                                                      } else {
                                                        callback();
                                                      }
                                                    }
                                                  );
                                                } else {
                                                  callback();
                                                }
                                              },
                                              (callback) => {
                                                if (
                                                  checklist.name === "Notes" &&
                                                  clientIds.boardType ===
                                                    "tax_return" &&
                                                  newClientCard
                                                ) {
                                                  pool.query(
                                                    getFinancialStatementsCountQuery,
                                                    [clientId, taxSeasonId],
                                                    (err, result) => {
                                                      if (err) throw err;

                                                      if (
                                                        result.rows.length >
                                                          0 &&
                                                        result.rows[0].count > 0
                                                      ) {
                                                        trelloInterface.trello.post(
                                                          "/1/checklists/" +
                                                            checklist.id +
                                                            "/checkItems",
                                                          {
                                                            name:
                                                              trelloInterface.financialStatementsWarning,
                                                            pos: "top",
                                                          },
                                                          (err, res) => {
                                                            if (err) throw err;
                                                            callback();
                                                          }
                                                        );
                                                      } else {
                                                        callback();
                                                      }
                                                    }
                                                  );
                                                } else {
                                                  callback();
                                                }
                                              },
                                            ],
                                            (err) => {
                                              if (err) throw err;
                                              callback();
                                            }
                                          );
                                        },
                                        (err) => {
                                          if (err) throw err;
                                          callback();
                                        }
                                      );
                                    }
                                  );
                                },
                              ],
                              (err) => {
                                if (err) {
                                  callback(err);
                                } else {
                                  callback();
                                }
                              }
                            );
                          }
                        }
                      });
                    },
                    (err) => {
                      if (err) {
                        callback(err);
                      } else {
                        callback();
                      }
                    }
                  );
                }
              },
              (err) => {
                if (err) {
                  callback(err);
                } else {
                  callback();
                }
              }
            );
          },

          (callback) => {
            async.eachSeries(
              existingDeliverables,
              (deliverable, callback) => {
                const queryText =
                  "SELECT trello_id FROM trello_relations WHERE controller_id = $1 AND tax_season_id = $2 AND type = 'deliverable' AND archived IS NULL AND board_type = 'tax_return'";
                const queryValues = [deliverable.id, taxSeasonId];
                const baseUrl = `${process.env.CONTROLLER_URL}/entities/${deliverable.entity.id}`;
                const link = `[:newlink:](${baseUrl})`;
                const checkItemName =
                  deliverable.entity.name +
                  " (" +
                  deliverable.getTypeDetail().name +
                  ")";
                const formattedString = `${link} ${checkItemName}`;
                let checkItemId = null;
                //let cardId = null;
                pool
                  .query(queryText, queryValues)
                  .then((pgResSelectTrelloRelationDeliverable) => {
                    if (pgResSelectTrelloRelationDeliverable.rows.length > 0) {
                      checkItemId =
                        pgResSelectTrelloRelationDeliverable.rows[0].trello_id;
                      // first, we need to check if this deliverable is split out on another card
                      // if we didn't find it on this card, then we need to see if this client has more than one card
                      // with deliverables split among them. the trello_id of a 'split_card' entry in trello_relations
                      // is the id of the card
                      const sqlSelectSplitCard = `SELECT trello_id FROM trello_relations 
																WHERE controller_id = '${deliverable.id}' 
																AND tax_season_id = '${taxSeasonId}'
																AND type = 'split_card' AND archived IS NULL AND board_type = 'tax_return'`;
                      return pool.query(sqlSelectSplitCard);
                    } else {
                      console.log(
                        `No entry in trello_relations for deliverableId: ${deliverable.id} : taxSeasonId: ${taxSeasonId}`
                      );
                      numSkippedDeliverables++;
                      callback();
                    }
                  })
                  .then((pgResSelectSplitCard) => {
                    if (pgResSelectSplitCard.rows.length > 0) {
                      console.log(
                        `Success : This deliverable is split out on a separate card`
                      );
                      return pgResSelectSplitCard.rows[0].trello_id;
                    } else {
                      console.log(
                        `No split card found. Checkitem should be on main client card`
                      );
                      const queryText =
                        "SELECT trello_id FROM trello_relations WHERE controller_id = $1 AND tax_season_id = $2 AND type = 'client' AND archived IS NULL AND board_type = 'tax_return'";
                      const queryValues = [
                        deliverable.entity.client.id,
                        taxSeasonId,
                      ];
                      return pool
                        .query(queryText, queryValues)
                        .then((pgResSelectClientCardId) => {
                          if (pgResSelectClientCardId.rows.length > 0) {
                            return pgResSelectClientCardId.rows[0].trello_id;
                          }
                        })
                        .catch((error) => {
                          console.log(
                            `Error : getSplitCardFromTrello : ${error}`
                          );
                        });
                    }
                  })
                  .then((cardId) => {
                    if (cardId === null) {
                      console.log(
                        `Error : No Card Id found in trello_relations for deliverable ${deliverable.id}`
                      );
                      callback();
                      return;
                    }
                    // let's grab the card checklists
                    console.log(`Get card with trello id: ${cardId}`);
                    return trello.makeRequest(
                      "get",
                      `/1/cards/${cardId}/checklists`
                    );
                  })
                  .then((checklists) => {
                    console.log(`Success getting card checklists`);
                    // get the Returns to File checklist
                    const idxReturnsToFile = checklists.findIndex(
                      (cl) => cl.name === "Returns to File"
                    );
                    if (idxReturnsToFile > -1) {
                      const checklistReturnsToFile =
                        checklists[idxReturnsToFile];
                      const idxCheckItem = checklistReturnsToFile.checkItems.findIndex(
                        (ci) => ci.id === checkItemId
                      );
                      // if we find the deliverable's checkitem in the list
                      // then update it
                      if (idxCheckItem > -1) {
                        console.log(
                          `PUT updated ChecklistItem : ${formattedString}`
                        );
                        return trello.makeRequest(
                          "put",
                          `/1/cards/${checklistReturnsToFile.idCard}/checkItem/${checkItemId}`
                        );
                      } else {
                        // otherwise create a new checkitem in the checklist
                        console.log(
                          `POST new ChecklistItem : ${formattedString}`
                        );
                        return trello
                          .addItemToChecklist(
                            checklistReturnsToFile.id,
                            formattedString
                          )
                          .then((res) => {
                            // if we make a new checkitem, then we have to update the deliverable's entry in trello_relations
                            const sqlUpdateTrelloRelations = `UPDATE trello_relations 
											SET trello_id='${res.id}' 
											WHERE controller_id = '${deliverable.id}' 
											AND tax_season_id = '${taxSeasonId}' 
											AND type = 'deliverable' AND archived IS NULL AND board_type = 'tax_return';`;
                            return pool.query(sqlUpdateTrelloRelations);
                          })
                          .catch((error) => {
                            console.log(
                              `Error : trello.addItemToChecklist : ${error}`
                            );
                          });
                      }
                    }
                  })
                  .then((trelloRes) => {
                    console.log(`Success : syncing card`);
                    callback();
                  })
                  .catch((error) => {
                    console.log(`Error : syncing card : ${error}`);
                    callback();
                  });
              },
              (err) => {
                if (err) {
                  callback(err);
                } else {
                  callback();
                }
              }
            );
          },
        ],
        (err) => {
          if (err) {
            responseCallback(err);
          } else {
            responseCallback(null, {
              numSkippedDeliverables,
              numUpdatedDeliverables,
              multipleCardClients,
            });
          }
        }
      );
    }
  });
};
