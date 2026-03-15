import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import twilio from "twilio";

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM_NUMBER = process.env.TWILIO_FROM_NUMBER;
const RAILWAY_URL = process.env.RAILWAY_URL;

const ON_CALL_NUMBERS = [
  process.env.TWILIO_TO_NUMBER,
  process.env.TWILIO_TO_NUMBER_T2,
  process.env.TWILIO_TO_NUMBER_T3,
  process.env.TWILIO_TO_NUMBER_T4,
];

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const activeIncidents = {};

async function escalateCall(incidentId, tierIndex = 0) {
  if (tierIndex >= ON_CALL_NUMBERS.length) {
    console.error(`❌ Incident ${incidentId}: Svi tierovi pozvani, niko se nije javio!`);
    return;
  }

  const incident = activeIncidents[incidentId];
  if (!incident) {
    console.error(`❌ Incident ${incidentId} nije pronađen u memoriji!`);
    return;
  }

  const toNumber = ON_CALL_NUMBERS[tierIndex];
  const tierName = `Tier ${tierIndex + 1}`;

  console.log(`📞 Pokušavam poziv: ${tierName} → ${toNumber}`);
  console.log(`📋 Twilio FROM: ${TWILIO_FROM_NUMBER}`);
  console.log(`📋 Twilio SID: ${TWILIO_ACCOUNT_SID}`);
  console.log(`📋 Railway URL: ${RAILWAY_URL}`);

  try {
    const call = await twilioClient.calls.create({
      to: toNumber,
      from: TWILIO_FROM_NUMBER,
      url: `${RAILWAY_URL}/twilio/voice?incidentId=${incidentId}&tier=${tierIndex}`,
      statusCallback: `${RAILWAY_URL}/twilio/status?incidentId=${incidentId}&tier=${tierIndex}`,
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
      timeout: 30,
    });

    console.log(`✅ Poziv pokrenut za ${tierName}: ${call.sid}`);
    activeIncidents[incidentId].callSid = call.sid;
    activeIncidents[incidentId].currentTier = tierIndex;

    activeIncidents[incidentId].escalationTimer = setTimeout(() => {
      if (!activeIncidents[incidentId]?.acknowledged) {
        console.log(`⏰ Incident ${incidentId}: ${tierName} nije potvrdio, eskalujem...`);
        escalateCall(incidentId, tierIndex + 1);
      }
    }, 120000);

  } catch (err) {
    console.error(`❌ Twilio greška za ${tierName}:`, err.message);
    console.error(`❌ Twilio detalji:`, err.code, err.status);
    escalateCall(incidentId, tierIndex + 1);
  }
}

app.all("/twilio/voice", (req, res) => {
  const { incidentId, tier } = req.query;
  const incident = activeIncidents[incidentId];
  const tierName = `Tier ${parseInt(tier) + 1}`;

  const severity = incident?.severity || "Unknown";
  const type = incident?.type || "Unknown";
  const description = incident?.description || "No description";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" action="${RAILWAY_URL}/twilio/gather?incidentId=${incidentId}&amp;tier=${tier}" method="POST" timeout="10"><Say voice="alice" language="en-US">Alert. New incident reported. Severity ${severity}. Type ${type}. Description ${description}. This is ${tierName} escalation. Press 1 to acknowledge and take ownership of this incident.</Say></Gather><Say voice="alice">No input received. Escalating to next tier.</Say></Response>`;

  res.type("text/xml");
  res.send(twiml);
});

app.all("/twilio/gather", async (req, res) => {
  const { incidentId, tier } = req.query;
  const digit = req.body?.Digits || req.query?.Digits;
  const incident = activeIncidents[incidentId];

  if (digit === "1" && incident) {
    incident.acknowledged = true;
    clearTimeout(incident.escalationTimer);

    console.log(`✅ Incident ${incidentId}: Tier ${parseInt(tier) + 1} potvrdio!`);

    try {
      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: incident.channel || "#inc-client-test",
          text: `✅ *Incident acknowledged!*\n*Incident ID:* ${incidentId}\n*Acknowledged by:* Tier ${parseInt(tier) + 1}\n*Status:* 🟡 In Progress`,
        },
        {
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      console.error("Error posting to Slack:", err.message);
    }

    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Thank you. You have acknowledged the incident. Please check Slack for details. Good luck.</Say></Response>`;
    res.type("text/xml");
    res.send(twiml);

  } else {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="alice">Invalid input. Escalating to next tier.</Say></Response>`;
    res.type("text/xml");
    res.send(twiml);
    escalateCall(incidentId, parseInt(tier) + 1);
  }
});

app.post("/twilio/status", (req, res) => {
  const { incidentId, tier } = req.query;
  const callStatus = req.body.CallStatus;
  const incident = activeIncidents[incidentId];

  console.log(`📋 Incident ${incidentId} Tier ${parseInt(tier) + 1} status: ${callStatus}`);

  if (
    !incident?.acknowledged &&
    (callStatus === "no-answer" || callStatus === "busy" || callStatus === "failed")
  ) {
    clearTimeout(incident?.escalationTimer);
    escalateCall(incidentId, parseInt(tier) + 1);
  }

  res.status(200).send();
});

app.post("/slack/command", async (req, res) => {
  const { trigger_id, channel_id } = req.body;
  res.status(200).send();

  try {
    await axios.post(
      "https://slack.com/api/views.open",
      {
        trigger_id,
        view: {
          type: "modal",
          callback_id: "incident_modal",
          private_metadata: channel_id,
          title: { type: "plain_text", text: "New Incident" },
          submit: { type: "plain_text", text: "Submit" },
          close: { type: "plain_text", text: "Cancel" },
          blocks: [
            {
              type: "input",
              block_id: "severity_block",
              label: { type: "plain_text", text: "Severity" },
              element: {
                type: "static_select",
                action_id: "severity_action",
                options: [
                  { text: { type: "plain_text", text: "P1 - Critical" }, value: "P1" },
                  { text: { type: "plain_text", text: "P2 - High" }, value: "P2" },
                  { text: { type: "plain_text", text: "P3 - Medium" }, value: "P3" },
                ],
              },
            },
            {
              type: "input",
              block_id: "type_block",
              label: { type: "plain_text", text: "Incident Type" },
              element: {
                type: "static_select",
                action_id: "type_action",
                options: [
                  { text: { type: "plain_text", text: "Layout" }, value: "Layout" },
                  { text: { type: "plain_text", text: "JS" }, value: "JS" },
                  { text: { type: "plain_text", text: "Forms" }, value: "Forms" },
                ],
              },
            },
            {
              type: "input",
              block_id: "desc_block",
              label: { type: "plain_text", text: "Description" },
              element: {
                type: "plain_text_input",
                action_id: "desc_action",
                multiline: true,
              },
            },
          ],
        },
      },
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Error opening modal:", err.response?.data || err.message);
  }
});

app.post("/slack/interactions", async (req, res) => {
  const payload = JSON.parse(req.body.payload);

  if (payload.type === "view_submission") {
    const values = payload.view.state.values;
    const severity = values.severity_block.severity_action.selected_option.value;
    const type = values.type_block.type_action.selected_option.value;
    const description = values.desc_block.desc_action.value;
    const user = payload.user.name;
    const channel = payload.view.private_metadata;

    const incidentId = `INC-${Date.now()}`;

    activeIncidents[incidentId] = {
      id: incidentId,
      severity,
      type,
      description,
      user,
      channel,
      acknowledged: false,
      createdAt: new Date().toISOString(),
    };

    res.json({ response_action: "clear" });

    try {
      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: channel || "#inc-client-test",
          text: `🚨 *New Incident — ${incidentId}*\n*Severity:* ${severity}\n*Type:* ${type}\n*Reported by:* @${user}\n*Description:* ${description}\n\n📞 _Pokrećem eskalaciju poziva..._`,
        },
        {
          headers: {
            Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );
    } catch (err) {
      console.error("Error posting to Slack:", err.response?.data || err.message);
    }

    escalateCall(incidentId, 0);

    return;
  }

  res.status(200).send();
});

app.get("/", (req, res) => {
  res.status(200).send("Server is healthy ✅");
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
