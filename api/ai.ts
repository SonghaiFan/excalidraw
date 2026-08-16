import { handleFrankAIRequest } from "../excalidraw-app/frank/ai-server";

export default {
  fetch(request: Request) {
    return handleFrankAIRequest(request, {
      openAIKey: process.env.OPENAI_API_KEY,
      openAIModel: process.env.OPENAI_MODEL,
    });
  },
};
