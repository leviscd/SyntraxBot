#!/usr/bin/env node
/**
 * Script para exportar a sessão Baileys como variável de ambiente
 * Uso: node export-session.js
 * 
 * Isso vai gerar uma variável WA_SESSION que você pode usar no Render
 */

import fs from "node:fs";
import path from "node:path";

const SESSION_DIR = path.join(process.cwd(), "data", "auth_info_baileys");

async function exportSession() {
  if (!fs.existsSync(SESSION_DIR)) {
    console.error(`❌ Pasta de sessão não encontrada: ${SESSION_DIR}`);
    console.error("Execute o bot localmente e após conectar, rode este script.");
    process.exit(1);
  }

  try {
    // Lê todos os arquivos da pasta de sessão
    const files = fs.readdirSync(SESSION_DIR);
    if (files.length === 0) {
      console.error("❌ Nenhum arquivo de sessão encontrado");
      process.exit(1);
    }

    // Cria um objeto com todos os arquivos
    const sessionData = {};
    for (const file of files) {
      const filePath = path.join(SESSION_DIR, file);
      const content = fs.readFileSync(filePath);
      // Armazena como base64 ou JSON (dependendo do tipo)
      try {
        sessionData[file] = JSON.parse(content.toString());
      } catch {
        sessionData[file] = content.toString("base64");
      }
    }

    // Converte para JSON e depois para Base64
    const jsonString = JSON.stringify(sessionData);
    const base64String = Buffer.from(jsonString).toString("base64");

    console.log("\n✅ SESSÃO EXPORTADA COM SUCESSO!\n");
    console.log("Copie a variável abaixo e adicione ao Render Dashboard:\n");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log(`WA_SESSION=${base64String}`);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    console.log("📋 Instruções:");
    console.log("1. Vá para https://dashboard.render.com/");
    console.log("2. Selecione seu serviço SyntraxBot");
    console.log("3. Vá em 'Environment'");
    console.log("4. Clique em 'Add Environment Variable'");
    console.log("5. Cole a variável acima");
    console.log("6. Salve e reinicie o serviço\n");
  } catch (error) {
    console.error("❌ Erro ao exportar sessão:", error.message);
    process.exit(1);
  }
}

exportSession();
