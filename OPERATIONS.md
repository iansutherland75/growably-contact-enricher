# Operations

Day-to-day notes for whoever looks after the install. Nothing here needs a terminal.

## Roles

- **User**: Add Contact and Enrich Contact.
- **Administrator**: everything, including Bulk Enrich and the Settings cards for integrations, fields, branding, brief profile and users.

Anyone allowed through Cloudflare Access can sign in. New people arrive as Users. Promote them under Settings, User Management. There must always be at least one administrator; the app refuses to demote or remove the last one, and nobody can change their own role.

## Bulk enrichment

Administrators start it from the Bulk Enrich page. Scope options:

- **All contacts**: walks the whole list.
- **Created since a date**: contacts added on or after that day (UTC).
- **With tag**: contacts carrying that tag.

A batch of ten runs every five minutes, with a pause between contacts to stay inside Growably's rate limits. Pause stops the job after the current batch; Resume picks up where it left off. Filtered jobs do not skip contacts that were already enriched, so re-running the same scope spends Apollo credits again.

Bulk enrichment needs the Cloudflare Workers Paid plan. On the Free plan a batch stops after two or three contacts and the failures leave no trace on the contact.

## The Apollo phone webhook

Mobile numbers do not come back during enrichment. Apollo looks them up afterwards and posts the result to `/api/apollo-webhook` on your app, usually within a couple of minutes. The app matches the post to the contact and writes the Mobile Number field.

For this to work, the webhook address must be reachable without sign-in (SETUP.md step 2d) and the app must know its own address. It learns the address from the first signed-in visit. If you move to a custom domain, sign in once on the new address.

Requests to the webhook carry a token derived from `CONFIG_KEY`. Requests without it are refused.

## Keys and rotation

Settings, Integrations. Click Update next to a service, paste the new key, click Test, then Save. The old key is replaced immediately. Keys are stored encrypted and only the last four characters are ever displayed.

If you rotate `CONFIG_KEY` itself (Cloudflare dashboard, your worker, Settings, Variables and Secrets), the stored keys can no longer be decrypted. Re-enter them under Integrations. Nothing else is affected.

## Common problems

**"Sign-in is not set up yet" after setup**
`ACCESS_TEAM_DOMAIN` or `ACCESS_APP_AUD` is blank, still says `pending`, or is malformed. The team domain must end in `.cloudflareaccess.com` and the AUD tag is 64 characters. Fix them under Variables and Secrets, wait a minute, reload.

**"Your sign-in could not be verified"**
The two values are present but do not match the Access application protecting this worker. Re-copy the AUD tag from the worker's Access tab in the Cloudflare dashboard.

**Every enrichment says "Fields not set up in Growably"**
Settings, Growably fields, Create missing fields.

**Mobile shows "arriving" but never lands**
Check the webhook bypass exists (SETUP.md step 2d). Check Apollo credits. The app keeps the Apollo-to-contact mapping for 24 hours; after that, enrich the contact again.

**Phone or postal code looks wrong**
Website scraping guesses from page text. Postal codes need a province or state abbreviation nearby, and phone numbers are checked against North American patterns, but odd pages still slip through. Fix the field in Growably; the app never overwrites a filled field on its own.

**A better value was found but not written**
By design. Enrichment fills empty fields only. When the new value differs from the existing one, the table shows an Overwrite button next to it.

**"Brief failed" toasts**
- A 401 or 403 from the provider means the AI key is wrong or revoked. Replace it under Integrations.
- A 404 naming the model means the model has been retired. Under Integrations, Update the AI provider and set a current model name, or clear it to use the default.
- 429, 500, 529: the provider was busy. The app retries twice on its own. Wait a minute and click again.
- "Failed to fetch": the browser gave up before the worker answered. Briefs take 30 to 60 seconds; Cloudflare cuts the connection at 100. Try again.

**Growably returns 401 on everything**
The Private Integration token was revoked or its scopes changed. Create a new one and paste it under Integrations.

**Growably returns 422 with "country must be valid"**
A contact has an empty-string country. Clear the field on the contact in Growably and enrich again.

## Logs

Cloudflare dashboard, Workers & Pages, your worker, Logs. Every request is kept for seven days with its status and any console output. Lines starting with `[brief]` record each brief's provider, model, token counts and timing. Lines starting with `[apollo-webhook]` record each phone delivery.

The Enrich Error field on a contact lists the non-fatal problems from its last enrichment, separated by semicolons.

## Locked out

If the only administrator leaves and nobody can reach User Management:

1. In the Cloudflare dashboard, go to Storage & Databases, then KV, and open the namespace attached to the worker.
2. Add a key named `user:you@yourdomain.com` (lowercase) with the value `{"role":"superuser"}`.
3. Sign in. You are an administrator.

## Uninstall

Delete the worker (Workers & Pages), the KV namespace (Storage & Databases), the two Access applications (Zero Trust, Access, Applications), and the repository the Deploy button created in your GitHub account. Growably keeps the custom fields and tags; delete them there if you do not want them.
