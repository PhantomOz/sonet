import { DirectClient } from "@elizaos/client-direct";
import axios from "axios";
export class SonetClient extends DirectClient {
  constructor() {
    super();
  }

  setupRoutes() {
    this.app.post("/webhook", async (req, res) => {
      // log incoming messages
      console.log(
        "Incoming webhook message:",
        JSON.stringify(req.body, null, 2)
      );

      // check if the webhook request contains a message
      // details on WhatsApp text message payload: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples#text-messages
      const message = req.body.entry?.[0]?.changes[0]?.value?.messages?.[0];
      const contact = req.body.entry?.[0]?.changes[0]?.value?.contacts?.[0];

      // check if the incoming message contains text
      if (message?.type === "text") {
        // extract the business number to send the reply from it
        const business_phone_number_id =
          req.body.entry?.[0].changes?.[0].value?.metadata?.phone_number_id;

        try {
          const serverPort = parseInt(process.env.PORT || "3000");

          const response = await fetch(
            `http://localhost:${serverPort}/sonet/message`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                text: message.text.body,
                userId: contact.wa_id,
                userName: contact.profile.name,
              }),
            }
          );

          const data = await response.json();
          data.forEach(async (message) => {
            // send a reply message as per the docs here https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
            await axios({
              method: "POST",
              url: `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
              headers: {
                Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`,
              },
              data: {
                messaging_product: "whatsapp",
                to: message.from,
                text: { body: "Echo: " + message.text },
                context: {
                  message_id: message.id, // shows the message as a reply to the original user message
                },
              },
            });
          });
        } catch (error) {
          console.error("Error fetching response:", error);
        }

        // mark incoming message as read
        await axios({
          method: "POST",
          url: `https://graph.facebook.com/v18.0/${business_phone_number_id}/messages`,
          headers: {
            Authorization: `Bearer ${process.env.GRAPH_API_TOKEN}`,
          },
          data: {
            messaging_product: "whatsapp",
            status: "read",
            message_id: message.id,
          },
        });
      }

      res.sendStatus(200);
    });

    this.app.get("/webhook", (req, res) => {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];

      // check the mode and token sent are correct
      if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        // respond with 200 OK and challenge token from the request
        res.status(200).send(challenge);
        console.log("Webhook verified successfully!");
      } else {
        // respond with '403 Forbidden' if verify tokens do not match
        res.sendStatus(403);
      }
    });
  }
}
