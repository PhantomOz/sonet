import { DirectClient, messageHandlerTemplate } from "@elizaos/client-direct";
import {
  Content,
  Memory,
  Media,
  composeContext,
  generateMessageResponse,
  ModelClass,
  getEmbeddingZeroVector,
  AgentRuntime,
  stringToUuid,
} from "@elizaos/core";
import path from "path";
import axios from "axios";

type AgentMessageParams = {
  roomId?: string;
  userId?: string;
  userName?: string;
  name?: string;
  text?: string;
  file?: {
    filename: string;
    mimetype: string;
    originalname: string;
  };
};

export class SonetClient extends DirectClient {
  private agent: AgentRuntime;
  constructor() {
    super();
  }
  async handleAgentMessage(params: AgentMessageParams) {
    const agentId = "Sonet";
    const roomId = stringToUuid(params.roomId ?? "default-room-" + agentId);
    const userId = stringToUuid(params.userId ?? "user");

    const runtime = this.agent;

    if (!runtime) {
      throw new Error("Agent not found");
    }

    await runtime.ensureConnection(
      userId,
      roomId,
      params.userName,
      params.name,
      "direct"
    );

    const text = params.text;
    // if empty text, directly return
    if (!text) {
      return [];
    }

    const messageId = stringToUuid(Date.now().toString());

    const attachments: Media[] = [];
    if (params.file) {
      const filePath = path.join(
        process.cwd(),
        "data",
        "uploads",
        params.file.filename
      );
      attachments.push({
        id: Date.now().toString(),
        url: filePath,
        title: params.file.originalname,
        source: "direct",
        description: `Uploaded file: ${params.file.originalname}`,
        text: "",
        contentType: params.file.mimetype,
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
      throw new Error("No response from generateMessageResponse");
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
        return [response, message];
      } else {
        return [response];
      }
    } else {
      if (message) {
        return [message];
      } else {
        return [];
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
          console.log("Handling agent message: ", message.text.body);

          const response = await this.handleAgentMessage({
            text: message.text.body,
            userId: contact.wa_id,
            userName: contact.profile.name,
          });

          const data = await response;
          console.log("Response: ", data);
          data.forEach(async (mess) => {
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
                text: { body: mess.text },
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

  addAgent(agent: AgentRuntime) {
    this.agent = agent;
  }
}
