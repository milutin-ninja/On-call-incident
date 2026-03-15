import express from "express";
import bodyParser from "body-parser";
import axios from "axios";

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

if (!SLACK_BOT_TOKEN) {
  console.error("SLACK_BOT_TOKEN nije postavljen!");
}

// Slash command
app.post("/slack/command", async (req, res) => {
  const { trigger_id } = req.body;

  res.status(200).send();

  try {
    await axios.post(
      "https://slack.com/api/views.open",
      {
        trigger_id,
        view: {
          type: "modal",
          callback_id: "incident_modal",
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
                  { text: { type: "plain_text", text: "P1" }, value: "P1" },
                  { text: { type: "plain_text", text: "P2" }, value: "P2" },
                  { text: { type: "plain_text", text: "P3" }, value: "P3" }
                ]
              }
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
                  { text: { type: "plain_text", text: "Forms" }, value: "Forms" }
                ]
              }
            },
            {
              type: "input",
              block_id: "desc_block",
              label: { type: "plain_text", text: "Description" },
              element: {
                type: "plain_text_input",
                action_id: "desc_action",
                multiline: true
              }
            }
          ]
        }
      },
      {
        headers: {
          Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
          "Content-Type": "application/json"
        }
      }
    );
  } catch (err) {
    console.error("Error opening modal:", err.response?.data || err.message);
  }
});

// Modal submit
app.post("/slack/interactions", (req, res) => {
  const payload = JSON.parse(req.body.payload);

  if (payload.type === "view_submission") {
    const values = payload.view.state.values;

    const severity =
      values.severity_block.severity_action.selected_option.value;

    const type =
      values.type_block.type_action.selected_option.value;

    const description =
      values.desc_block.desc_action.value;

    console.log("🚨 INCIDENT RECEIVED:");
    console.log("Severity:", severity);
    console.log("Type:", type);
    console.log("Description:", description);

    return res.json({
      response_action: "clear"
    });
  }

  res.status(200).send();
});

// Health check
app.get("/", (req, res) => {
  res.status(200).send("Server is healthy ✅");
});

const port = process.env.PORT || 8080;

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
