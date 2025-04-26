import { DirectClient } from "@elizaos/client-direct";

export class SonetClient extends DirectClient {
  constructor() {
    super();
  }

  setupRoutes() {
    this.app.get("/webhook", (req, res) => {
      res.send("Hello World Nigga");
    });
  }
}
