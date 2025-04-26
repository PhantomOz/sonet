import { DirectClient } from "@elizaos/client-direct";
import { AgentRuntime, stringToUuid } from "@elizaos/core/dist";
import {
  Content,
  Memory,
  Media,
  composeContext,
  generateMessageResponse,
  ModelClass,
  getEmbeddingZeroVector,
} from "@elizaos/core";
import { Request, Response } from "express";
import path from "path";
import axios from "axios";

export class SonetClient extends DirectClient {
  private agents: Map<string, AgentRuntime>;
  constructor() {
    super();
  }
  async handleAgentMessage(req: Request, res: Response) {
    const agentId = "Sonet";
    const roomId = stringToUuid(req.body.roomId ?? "default-room-" + agentId);
    const userId = stringToUuid(req.body.userId ?? "user");

    const runtime = this.agents.get(agentId);

    if (!runtime) {
      res.status(404).send("Agent not found");
      return;
    }

    await runtime.ensureConnection(
      userId,
      roomId,
      req.body.userName,
      req.body.name,
      "direct"
    );

    const text = req.body.text;
    // if empty text, directly return
    if (!text) {
      res.json([]);
      return;
    }

    const messageId = stringToUuid(Date.now().toString());

    const attachments: Media[] = [];
    if (req.file) {
      const filePath = path.join(
        process.cwd(),
        "data",
        "uploads",
        req.file.filename
      );
      attachments.push({
        id: Date.now().toString(),
        url: filePath,
        title: req.file.originalname,
        source: "direct",
        description: `Uploaded file: ${req.file.originalname}`,
        text: "",
        contentType: req.file.mimetype,
      });
    }

    const content: Content = {
      text,
      attachments,
      source: "direct",
      inReplyTo: undefined,
    };

    const userMessage = {
      content,
      userId,
      roomId,
      agentId: runtime.agentId,
    };

    const memory: Memory = {
      id: stringToUuid(messageId + "-" + userId),
      ...userMessage,
      agentId: runtime.agentId,
      userId,
      roomId,
      content,
      createdAt: Date.now(),
    };

    await runtime.messageManager.addEmbeddingToMemory(memory);
    await runtime.messageManager.createMemory(memory);

    let state = await runtime.composeState(userMessage, {
      agentName: runtime.character.name,
    });

    const context = composeContext({
      state,
      template: messageHandlerTemplate,
    });

    const response = await generateMessageResponse({
      runtime: runtime,
      context,
      modelClass: ModelClass.LARGE,
    });

    if (!response) {
      res.status(500).send("No response from generateMessageResponse");
      return;
    }

    // save response to memory
    const responseMessage: Memory = {
      id: stringToUuid(messageId + "-" + runtime.agentId),
      ...userMessage,
      userId: runtime.agentId,
      content: response,
      embedding: getEmbeddingZeroVector(),
      createdAt: Date.now(),
    };

    await runtime.messageManager.createMemory(responseMessage);

    state = await runtime.updateRecentMessageState(state);

    let message = null as Content | null;

    await runtime.processActions(
      memory,
      [responseMessage],
      state,
      async (newMessages) => {
        message = newMessages;
        return [memory];
      }
    );

    await runtime.evaluate(memory, state);

    // Check if we should suppress the initial message
    const action = runtime.actions.find((a) => a.name === response.action);
    const shouldSuppressInitialMessage = action?.suppressInitialMessage;

    if (!shouldSuppressInitialMessage) {
      if (message) {
        res.json([response, message]);
      } else {
        res.json([response]);
      }
    } else {
      if (message) {
        res.json([message]);
      } else {
        res.json([]);
      }
    }
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
            `https://sonet-production.up.railway.app/Sonet/message`,
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
