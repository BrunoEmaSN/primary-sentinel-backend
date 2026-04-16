#!/usr/bin/env node
/**
 * Crea un usuario de prueba en Supabase Auth (y el perfil vía trigger handle_new_user).
 *
 * Credenciales por defecto (solo desarrollo):
 *   Email:    sentinel-test@example.com
 *   Password: SentinelTest123!
 *
 * Uso:
 *   export SUPABASE_URL=... SUPABASE_SERVICE_KEY=...
 *   node scripts/seed-test-user.mjs
 *
 * O deja SUPABASE_URL / SUPABASE_SERVICE_KEY en .dev.vars (raíz del backend).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const DEFAULT_EMAIL = "sentinel-test@example.com";
const DEFAULT_PASSWORD = "SentinelTest123!";
const DEFAULT_FULL_NAME = "Usuario de prueba Sentinel";

function loadDevVars() {
  const p = join(ROOT, ".dev.vars");
  if (!existsSync(p)) return {};
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const key = t.slice(0, i).trim();
    let val = t.slice(i + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function env() {
  const f = loadDevVars();
  const url = process.env.SUPABASE_URL || f.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || f.SUPABASE_SERVICE_KEY;
  return { url, key };
}

const { url, key } = env();
if (!url || !key) {
  console.error(
    "Faltan SUPABASE_URL y/o SUPABASE_SERVICE_KEY (export o .dev.vars)."
  );
  process.exit(1);
}

const supabase = createClient(url, key, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const email = process.env.SEED_TEST_EMAIL || DEFAULT_EMAIL;
const password = process.env.SEED_TEST_PASSWORD || DEFAULT_PASSWORD;
const fullName = process.env.SEED_TEST_FULL_NAME || DEFAULT_FULL_NAME;

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: fullName },
});

if (error) {
  const msg = error.message || String(error);
  if (/already|registered|exists|duplicate/i.test(msg)) {
    console.log(`El usuario ${email} ya existe. No se creó nada nuevo.`);
    process.exit(0);
  }
  console.error("Error al crear usuario:", msg);
  process.exit(1);
}

const user = data.user;
console.log("Usuario de prueba creado.");
console.log("  id:", user.id);
console.log("  email:", user.email);
console.log("  contraseña:", password);
console.log("");
console.log(
  "En el frontend, inicia sesión con ese email y contraseña; el Bearer JWT usará tenantId = id."
);
