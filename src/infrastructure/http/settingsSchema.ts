import { z } from "zod";

const optionalHttpsUrl = z
  .union([z.string().url().max(2048).refine((u) => u.startsWith("https:"), "URL must use https"), z.null()])
  .optional();

export const putSettingsBodySchema = z
  .object({
    notify_email_healing: z.boolean().optional(),
    notify_email_dead: z.boolean().optional(),
    notify_email_pending_rules: z.boolean().optional(),
    slack_on_incidents: z.boolean().optional(),
    slack_incoming_webhook_url: optionalHttpsUrl,
    alert_webhook_url: optionalHttpsUrl,
    alert_webhook_secret: z.union([z.string().max(512), z.null()]).optional(),
  })
  .strict();

export type PutSettingsBody = z.infer<typeof putSettingsBodySchema>;
