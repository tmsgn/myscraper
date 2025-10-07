import app from "../app.js";

// Catch-all API route for Vercel to forward any /api/* request to Express
export default function handler(req, res) {
  return app(req, res);
}
