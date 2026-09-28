import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

const WP_URL = process.env.WORDPRESS_URL;
const WP_USER = process.env.WORDPRESS_USERNAME;
const WP_PASSWORD = process.env.WORDPRESS_APPLICATION_PASSWORD;
const transports = new Map();

function wpHeaders() {
  const auth = Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString("base64");

  return {
    Authorization: `Basic ${auth}`,
    "Content-Type": "application/json"
  };
}

async function wordpress(path, options = {}) {
  const response = await fetch(`${WP_URL}/wp-json/wp/v2${path}`, {
    ...options,
    headers: {
      ...wpHeaders(),
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

function createMcpServer() {
  const server = new McpServer({
    name: "pratica-publica-wordpress",
    version: "1.0.0"
  });

  server.tool(
    "listar_posts",
    "Lista os posts do WordPress da Pratica Publica.",
    {
      quantidade: z.number().int().min(1).max(100).optional()
    },
    async ({ quantidade = 10 }) => {
      const posts = await wordpress(`/posts?per_page=${quantidade}`);

      return {
        content: [{
          type: "text",
          text: JSON.stringify(posts, null, 2)
        }]
      };
    }
  );

  server.tool(
    "buscar_posts",
    "Pesquisa posts existentes no WordPress.",
    {
      busca: z.string()
    },
    async ({ busca }) => {
      const posts = await wordpress(
        `/posts?search=${encodeURIComponent(busca)}&per_page=20`
      );

      return {
        content: [{
          type: "text",
          text: JSON.stringify(posts, null, 2)
        }]
      };
    }
  );

  server.tool(
    "listar_categorias",
    "Lista as categorias disponiveis no WordPress.",
    {},
    async () => {
      const categories = await wordpress("/categories?per_page=100");

      return {
        content: [{
          type: "text",
          text: JSON.stringify(categories, null, 2)
        }]
      };
    }
  );

  server.tool(
    "criar_rascunho",
    "Cria um novo post como rascunho. Nao publica automaticamente.",
    {
      titulo: z.string(),
      conteudo: z.string(),
      categoria: z.number().int().optional()
    },
    async ({ titulo, conteudo, categoria }) => {
      const body = {
        title: titulo,
        content: conteudo,
        status: "draft"
      };

      if (categoria) {
        body.categories = [categoria];
      }

      const post = await wordpress("/posts", {
        method: "POST",
        body: JSON.stringify(body)
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            sucesso: true,
            id: post.id,
            titulo: post.title?.rendered,
            status: post.status,
            link: post.link
          }, null, 2)
        }]
      };
    }
  );

  return server;
}

app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "Pratica Publica WordPress MCP"
  });
});

app.post("/mcp", async (req, res) => {
  const existingSessionId = req.headers["mcp-session-id"];
  let transport = existingSessionId ? transports.get(existingSessionId) : undefined;

  if (!transport) {
    const server = createMcpServer();

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        transports.set(sessionId, transport);
      }
    });

    transport.onclose = () => {
      if (transport.sessionId) {
        transports.delete(transport.sessionId);
      }
      server.close();
    };

    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Pratica Publica MCP rodando na porta ${PORT}`);
});
