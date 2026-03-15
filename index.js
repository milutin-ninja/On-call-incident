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

    // Slack-u moramo odgovoriti 200
    return res.json({
      response_action: "clear"
    });
  }

  res.status(200).send();
});
