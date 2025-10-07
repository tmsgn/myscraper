import app from "../app.js";

// Export the Express app directly for Vercel's Node.js runtime
export default function handler(req, res) {
	return app(req, res);
}
