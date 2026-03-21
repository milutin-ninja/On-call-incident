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
const CLICKUP_API_KEY = process.env.CLICKUP_API_KEY;
const CLICKUP_PHONE_DOC_ID = "8cn80zu-52054";
const CLICKUP_PHONE_PAGE_ID = "8cn80zu-65534";

// Team Lead mapping po Space-u
const TEAM_LEADS = {
  "NPD Team": { name: "Andrija Djuric", clickupId: "42457090" },
  "New Cookies Team": { name: "Filip Nicic", clickupId: null },
  "Imperija Team": { name: "Marko Vukic", clickupId: null },
  "Test Team": { name: "Nemanja Vasilevski", clickupId: null },
};

// CTO je uvek Tier 3
const CTO = { name: "Stefan Mikic", clickupId: "42457093" };

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const activeIncidents = {};

// Čita Phone Directory iz ClickUp dokumenta
async function getPhoneDirectory() {
  try {
    const response = await axios.get(
      `https://api.clickup.com/api/v3/workspaces/9014871034/docs/${CLICKUP_PHONE_DOC_ID}/pages/${CLICKUP_PHONE_PAGE_ID}`,
      { headers: { Authorization: CLICKUP_API_KEY } }
    );
    const content = response.data.content;
    const phoneMap = {};

    const rows = content.split("\n").filter(row => row.startsWith("|") && !row.includes("---") && !row.includes("Profil"));
    for (const row of rows) {
      const cells = row.split("|").map(c => c.trim()).filter(Boolean);
      if (cells.length >= 3) {
        const profileCell = cells[0];
        const phone = cells[2];
        const match = profileCell.match(/user_mention#(\d+)/);
        if (match) {
          phoneMap[match[1]] = phone;
        }
      }
    }
    console.log("📋 Phone Directory loaded:", phoneMap);
    return phoneMap;
  } catch (err) {
    console.error("❌ Error reading Phone Directory:", err.message);
    return {};
  }
}

// Čita assignee iz task liste foldera
async function getListAssignee(listId) {
  try {
    const response = await axios.get(
      `https://api.clickup.com/api/v2/list/${listId}/task`,
      { headers: { Authorization: CLICKUP_API_KEY } }
    );
    const tasks = response.data.tasks;
    if (tasks && tasks.length > 0 && tasks[0].assignees.length > 0) {
      return tasks[0].assignees[0];
    }
    return null;
  } catch (err) {
    console.error("❌ Error reading list tasks:", err.message);
    return null;
  }
}

// Pronađi space ime na osnovu folder ID-a
async function getSpaceNameForFolder(folderId) {
  try {
    const response = await axios.get(
      `https://api.clickup.com/api/v2/folder/${folderId}`,
      { headers: { Authorization: CLICKUP_API_KEY } }
    );
    return response.data.space?.name || null;
  } catch (err) {
    console.error("❌ Error getting space name:", err.message);
    return null;
  }
}

// Gradi eskalacioni lanac na osnovu channel ID-a
async function buildEscalationChain(channelId) {
  console.log(`🔍 Building escalation chain for channel: ${channelId}`);
  console.log(`🔍 All env vars with SLACK_CHANNEL:`, Object.keys(process.env).filter(k => k.startsWith("SLACK_CHANNEL_")));

  // Traži varijablu po channel ID-u u svim env varijablama
  const envVar = Object.keys(process.env).find(
    key => key.startsWith("SLACK_CHANNEL_") && key.includes(channelId)
  );
  const folderId = envVar ? process.env[envVar] : null;

  console.log(`🔍 Found env var: ${envVar} → folder: ${folderId}`);

  if (!folderId) {
    console.error(`❌ No mapping for channel ${channelId}`);
    return null;
  }

  const phoneDirectory = await getPhoneDirectory();

  // Tier 1 — assignee iz task liste foldera
  const listId = "901414563380";
  const assignee = await getListAssignee(listId);
  console.log("👤 Assignee:", assignee?.username, assignee?.id);

  // Space ime za Team Lead lookup
  const spaceName = await getSpaceNameForFolder(folderId);
  console.log("🏢 Space:", spaceName);

  const teamLead = spaceName ? TEAM_LEADS[spaceName] : null;
  const cto = CTO;

  const chain = [];

  // Tier 1 — Developer (assignee)
  if (assignee) {
    const phone = phoneDirectory[String(assignee.id)];
    console.log(`📞 Tier 1 — ${assignee.username}: phone=${phone}`);
    chain.push({
      name: assignee.username || assignee.email,
      phone: phone || null,
      tier: 1,
    });
  }

  // Tier 2 — Team Lead
  if (teamLead) {
    const phone = teamLead.clickupId ? phoneDirectory[teamLead.clickupId] : null;
    console.log(`📞 Tier 2 — ${teamLead.name}: phone=${phone}`);
    chain.push({
      name: teamLead.name,
      phone: phone || null,
      tier: 2,
    });
  }

  // Tier 3 — CTO
  const ctoPhone = cto.clickupId ? phoneDirectory[cto.clickupId] : null;
  console.log(`📞 Tier 3 — ${cto.name}: phone=${ctoPhone}`);
  chain.push({
    name: cto.name,
    phone: ctoPhone || null,
    tier: 3,
  });

  console.log("✅ Final escalation chain:", JSON.stringify(chain));
  return chain;
}

// Eskalacija
async function escalateCall(incidentId, tierIndex = 0) {
  const incident = activeIncidents[incidentId];
  if (!incident) {
    console.error(`❌ Incident ${incidentId} not found!`);
    return;
  }

  const chain = incident.escalationChain;

  if (!chain || tierIndex >= chain.length) {
    console.error(`❌ Incident ${incidentId}: All tiers called, no one answered!`);
    return;
  }

  const person = chain[tierIndex];
  const tierName = `Tier ${person.tier}`;

  if (!person.phone) {
    console.error(`❌ ${person.name} has no phone number in Phone Directory!`);
    escalateCall(incidentId, tierIndex + 1);
    return;
  }

  console.log(`📞 Calling ${tierName} — ${person.name}: ${person.phone}`);

  try {
    const call = await twilioClient.calls.create({
      to: person.phone,
      from: TWILIO_FROM_NUMBER,
      url: `${RAILWAY_URL}/twilio/voice?incidentId=${incidentId}&tier=${tierIndex}`,
      statusCallback: `${RAILWAY_URL}/twilio/status?incidentId=${incidentId}&tier=${tierIndex}`,
      statusCallbackEvent: ["completed", "no-answer", "busy", "failed"],
      timeout: 30,
    });

    console.log(`✅ Call initiated for ${tierName}: ${call.sid}`);
    activeIncidents[incidentId].callSid = call.sid;
    activeIncidents[incidentId].currentTier = tierIndex;

    activeIncidents[incidentId].escalationTimer = setTimeout(() => {
      if (!activeIncidents[incidentId]?.acknowledged) {
        console.log(`⏰ ${tierName} did not confirm, escalating...`);
        escalateCall(incidentId, tierIndex + 1);
      }
    }, 120000);

  } catch (err) {
    console.error(`❌ Twilio error for ${tierName}:`, err.message);
    escalateCall(incidentId, tierIndex + 1);
  }
}

app.all("/twilio/voice", (req, res) => {
  const { incidentId, tier } = req.query;
  const incident = activeIncidents[incidentId];
  const chain = incident?.escalationChain;
  const person = chain?.[parseInt(tier)];
  const tierName = person ? `Tier ${person.tier}` : `Tier ${parseInt(tier) + 1}`;

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
  const chain = incident?.escalationChain;
  const person = chain?.[parseInt(tier)];

  if (digit === "1" && incident) {
    incident.acknowledged = true;
    clearTimeout(incident.escalationTimer);

    console.log(`✅ Incident ${incidentId}: ${person?.name || "Tier " + (parseInt(tier) + 1)} acknowledged!`);

    try {
      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: incident.channel || "#inc-client-test",
          text: `✅ *Incident acknowledged!*\n*Incident ID:* ${incidentId}\n*Acknowledged by:* ${person?.name || "Tier " + (parseInt(tier) + 1)}\n*Status:* 🟡 In Progress`,
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
  const chain = incident?.escalationChain;
  const person = chain?.[parseInt(tier)];

  console.log(`📋 Incident ${incidentId} ${person?.name || "Tier " + (parseInt(tier) + 1)} status: ${callStatus}`);

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

    const escalationChain = await buildEscalationChain(channel);

    activeIncidents[incidentId] = {
      id: incidentId,
      severity,
      type,
      description,
      user,
      channel,
      acknowledged: false,
      escalationChain,
      createdAt: new Date().toISOString(),
    };

    res.json({ response_action: "clear" });

    const chainText = escalationChain
      ? escalationChain.map(p => `Tier ${p.tier}: ${p.name}`).join(" → ")
      : "No escalation chain found!";

    try {
      await axios.post(
        "https://slack.com/api/chat.postMessage",
        {
          channel: channel || "#inc-client-test",
          text: `🚨 *New Incident — ${incidentId}*\n*Severity:* ${severity}\n*Type:* ${type}\n*Reported by:* @${user}\n*Description:* ${description}\n\n📞 *Escalation chain:* ${chainText}\n_Initiating call escalation..._`,
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

    if (escalationChain && escalationChain.length > 0) {
      escalateCall(incidentId, 0);
    } else {
      console.error(`❌ Incident ${incidentId}: No escalation chain for channel ${channel}`);
    }

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
