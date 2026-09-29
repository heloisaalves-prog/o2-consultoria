import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json({ limit: "25mb" }));

const WP_URL = process.env.WORDPRESS_URL;
const WP_USER = process.env.WORDPRESS_USERNAME;
const WP_PASSWORD = process.env.WORDPRESS_APPLICATION_PASSWORD;
const transports = new Map();

function authHeader() {
  return `Basic ${Buffer.from(`${WP_USER}:${WP_PASSWORD}`).toString("base64")}`;
}

function jsonHeaders() {
  return {
    Authorization: authHeader(),
    "Content-Type": "application/json"
  };
}

async function wordpress(path, options = {}) {
  const response = await fetch(`${WP_URL}/wp-json/wp/v2${path}`, {
    ...options,
    headers: {
      ...jsonHeaders(),
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(JSON.stringify(data));
  }

  return data;
}

function slugify(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function ensureTerm(taxonomy, name) {
  const slug = slugify(name);
  const existing = await wordpress(`/${taxonomy}?slug=${encodeURIComponent(slug)}&per_page=100`);

  if (existing.length > 0) {
    return existing[0].id;
  }

  const created = await wordpress(`/${taxonomy}`, {
    method: "POST",
    body: JSON.stringify({ name, slug })
  });

  return created.id;
}

async function uploadMedia({ nome_arquivo, mime_type, imagem_base64, alt_text }) {
  const buffer = Buffer.from(imagem_base64, "base64");
  const response = await fetch(`${WP_URL}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Disposition": `attachment; filename="${nome_arquivo}"`,
      "Content-Type": mime_type
    },
    body: buffer
  });

  const text = await response.text();
  const media = text ? JSON.parse(text) : null;

  if (!response.ok) {
    throw new Error(JSON.stringify(media));
  }

  if (alt_text) {
    await wordpress(`/media/${media.id}`, {
      method: "POST",
      body: JSON.stringify({ alt_text })
    });
  }

  return media;
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlValue(value) {
  if (Array.isArray(value)) {
    return `<array><data>${value.map((item) => `<value>${xmlValue(item)}</value>`).join("")}</data></array>`;
  }

  if (value && typeof value === "object") {
    return `<struct>${Object.entries(value)
      .map(([key, item]) => `<member><name>${xmlEscape(key)}</name><value>${xmlValue(item)}</value></member>`)
      .join("")}</struct>`;
  }

  if (typeof value === "number") {
    return `<int>${value}</int>`;
  }

  if (value instanceof Date) {
    const pad = (n) => String(n).padStart(2, "0");
    return `<dateTime.iso8601>${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}</dateTime.iso8601>`;
  }

  return `<string>${xmlEscape(value)}</string>`;
}

async function xmlRpc(methodName, params) {
  const body = `<?xml version="1.0"?>
<methodCall>
  <methodName>${xmlEscape(methodName)}</methodName>
  <params>${params.map((param) => `<param><value>${xmlValue(param)}</value></param>`).join("")}</params>
</methodCall>`;

  const response = await fetch(`${WP_URL}/xmlrpc.php`, {
    method: "POST",
    headers: { "Content-Type": "text/xml" },
    body
  });

  const text = await response.text();

  if (!response.ok || text.includes("<fault>")) {
    throw new Error(text);
  }

  return text;
}

function firstXmlString(xml) {
  const match = xml.match(/<string>([\s\S]*?)<\/string>|<int>([\s\S]*?)<\/int>|<i4>([\s\S]*?)<\/i4>/);
  if (!match) return null;
  return (match[1] || match[2] || match[3] || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function createMcpServer() {
  const server = new McpServer({
    name: "pratica-publica-wordpress",
    version: "1.1.0"
  });

  server.tool(
    "listar_posts",
    "Lista os posts do WordPress da Pratica Publica.",
    {
      quantidade: z.number().int().min(1).max(100).optional()
    },
    async ({ quantidade = 10 }) => {
      const posts = await wordpress(`/posts?per_page=${quantidade}`);
      return { content: [{ type: "text", text: JSON.stringify(posts, null, 2) }] };
    }
  );

  server.tool(
    "buscar_posts",
    "Pesquisa posts existentes no WordPress.",
    {
      busca: z.string()
    },
    async ({ busca }) => {
      const posts = await wordpress(`/posts?search=${encodeURIComponent(busca)}&per_page=20`);
      return { content: [{ type: "text", text: JSON.stringify(posts, null, 2) }] };
    }
  );

  server.tool(
    "listar_categorias",
    "Lista as categorias disponiveis no WordPress.",
    {},
    async () => {
      const categories = await wordpress("/categories?per_page=100");
      return { content: [{ type: "text", text: JSON.stringify(categories, null, 2) }] };
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
      const body = { title: titulo, content: conteudo, status: "draft" };
      if (categoria) body.categories = [categoria];
      const post = await wordpress("/posts", { method: "POST", body: JSON.stringify(body) });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sucesso: true, id: post.id, titulo: post.title?.rendered, status: post.status, link: post.link }, null, 2)
        }]
      };
    }
  );

  server.tool(
    "criar_post_completo",
    "Cria post completo no WordPress com status publicado ou agendado, imagem destacada, categoria, tags e metadados de SEO.",
    {
      titulo: z.string(),
      conteudo_html: z.string(),
      slug: z.string(),
      resumo: z.string(),
      categoria: z.string(),
      tags: z.array(z.string()).optional(),
      status: z.enum(["publish", "future", "draft"]),
      data_iso: z.string(),
      imagem_base64: z.string().optional(),
      nome_arquivo: z.string().optional(),
      mime_type: z.string().optional(),
      alt_text: z.string().optional(),
      seo_titulo: z.string().optional(),
      seo_descricao: z.string().optional(),
      seo_frase_chave: z.string().optional(),
      social_titulo: z.string().optional(),
      social_descricao: z.string().optional()
    },
    async (args) => {
      const categoryId = await ensureTerm("categories", args.categoria);
      const tagIds = [];

      for (const tag of args.tags || []) {
        tagIds.push(await ensureTerm("tags", tag));
      }

      let media;
      if (args.imagem_base64 && args.nome_arquivo && args.mime_type) {
        media = await uploadMedia(args);
      }

      const meta = {};
      if (args.seo_titulo) meta._yoast_wpseo_title = args.seo_titulo;
      if (args.seo_descricao) meta._yoast_wpseo_metadesc = args.seo_descricao;
      if (args.seo_frase_chave) meta._yoast_wpseo_focuskw = args.seo_frase_chave;
      if (args.social_titulo) {
        meta["_yoast_wpseo_opengraph-title"] = args.social_titulo;
        meta["_yoast_wpseo_twitter-title"] = args.social_titulo;
      }
      if (args.social_descricao) {
        meta["_yoast_wpseo_opengraph-description"] = args.social_descricao;
        meta["_yoast_wpseo_twitter-description"] = args.social_descricao;
      }

      const body = {
        title: args.titulo,
        content: args.conteudo_html,
        excerpt: args.resumo,
        slug: args.slug,
        status: args.status,
        date: args.data_iso,
        categories: [categoryId],
        tags: tagIds,
        meta
      };

      if (media) body.featured_media = media.id;

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
            data: post.date,
            slug: post.slug,
            link: post.link,
            imagem_destacada: media ? { id: media.id, link: media.source_url } : null,
            seo_meta_observacao: Object.keys(meta).length > 0 ? "Campos Yoast enviados via REST API." : null
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
      if (transport.sessionId) transports.delete(transport.sessionId);
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
