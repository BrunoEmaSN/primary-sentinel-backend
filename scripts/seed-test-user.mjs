#!/usr/bin/env node
/**
 * Crea un usuario de prueba en Supabase Auth (y el perfil vía trigger handle_new_user).
 *
 * Contraseña: definí `SEED_TEST_PASSWORD` (obligatorio). Solo en local podés usar
 *   `ALLOW_DEFAULT_SEED_CREDENTIALS=1` para permitir la contraseña de ejemplo del repo.
 *
 * Uso:
 *   export SUPABASE_URL=... SUPABASE_SERVICE_KEY=... SEED_TEST_PASSWORD='...'
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

const emailRaw = process.env.SEED_TEST_EMAIL || DEFAULT_EMAIL;
const email = emailRaw.trim().toLowerCase();
const allowDefaultCreds = process.env.ALLOW_DEFAULT_SEED_CREDENTIALS === "1";
const password =
  process.env.SEED_TEST_PASSWORD?.trim() ||
  (allowDefaultCreds ? DEFAULT_PASSWORD : "");
if (!password) {
  console.error(
    "Definí SEED_TEST_PASSWORD en el entorno, o ALLOW_DEFAULT_SEED_CREDENTIALS=1 solo para desarrollo local."
  );
  process.exit(1);
}
if (allowDefaultCreds && !process.env.SEED_TEST_PASSWORD?.trim()) {
  console.warn(
    "⚠️  ALLOW_DEFAULT_SEED_CREDENTIALS=1: usando contraseña de ejemplo del script (no uses en staging/producción)."
  );
}
const fullName = process.env.SEED_TEST_FULL_NAME || DEFAULT_FULL_NAME;

function isDuplicateUserError(msg) {
  return /already|registered|exists|duplicate/i.test(msg);
}

async function findUserIdByEmail(supabaseClient, targetEmail) {
  const want = targetEmail.toLowerCase();
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error: listErr } = await supabaseClient.auth.admin.listUsers({
      page,
      perPage,
    });
    if (listErr) throw listErr;
    const users = data?.users ?? [];
    const hit = users.find((u) => (u.email ?? "").toLowerCase() === want);
    if (hit) return hit.id;
    if (users.length < perPage) return null;
    page += 1;
  }
}

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: fullName },
});

if (error) {
  const msg = error.message || String(error);
  if (isDuplicateUserError(msg)) {
    const userId = await findUserIdByEmail(supabase, email);
    if (!userId) {
      console.error(
        "El email parece duplicado pero no se encontró el usuario al listar. Revisá el proyecto en Supabase."
      );
      process.exit(1);
    }
    const { error: upErr } = await supabase.auth.admin.updateUserById(userId, {
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (upErr) {
      console.error("No se pudo actualizar la contraseña del usuario:", upErr.message);
      process.exit(1);
    }
    console.log(`Usuario ${email} ya existía; contraseña y email confirmado actualizados.`);
    console.log("  id:", userId);
    console.log("  contraseña:", password);
    console.log("");
    console.log("Proyecto Supabase (debe coincidir con NEXT_PUBLIC_SUPABASE_URL del frontend):");
    console.log(" ", url);
    console.log("");
    console.log(
      "En el frontend, iniciá sesión con ese email y contraseña; el Bearer JWT usará tenantId = id."
    );
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
console.log("Proyecto Supabase (debe coincidir con NEXT_PUBLIC_SUPABASE_URL del frontend):");
console.log(" ", url);
console.log("");
console.log(
  "En el frontend, iniciá sesión con ese email y contraseña; el Bearer JWT usará tenantId = id."
);
