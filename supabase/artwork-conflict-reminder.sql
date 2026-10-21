-- Artwork-Review: taegliche Konflikt-Erinnerung (09:00 Europe/Berlin).
--
-- Projekt: ekiwwjzmiywaxvxdhzat (Creative-Review-Tool)
-- Funktion: creative-review-function.ts, Route POST /remind?format=artworks
--
-- pg_cron 1.6 und pg_net 0.20 sind auf diesem Projekt schon aktiv.
-- cron.schedule hat hier keine Timezone-Argumente, cron.timezone steht auf GMT.
-- Deshalb zwei UTC-Stunden (07:00 und 08:00) und ein Filter auf die Berliner
-- Stunde: 07:00 UTC ist 09:00 waehrend der Sommerzeit, 08:00 UTC ist 09:00
-- waehrend der Normalzeit. Genau eine der beiden Laeufe ruft die Function auf.
-- Die Function selbst sendet nur, wenn offene Konflikte > 0 sind.
--
-- Der Review-Key wird zur Laufzeit aus Vault gelesen (Name REVIEW_KEY).
-- Das ist derselbe Wert wie das Edge-Secret REVIEW_KEY. Den Wert nicht in
-- diese Datei und nicht ins Repo schreiben.
--
-- Einmalig, im SQL-Editor, bevor dieses Skript laeuft
-- (Dashboard → Database → Vault, oder der Aufruf unten mit dem echten Wert
-- nur dort einfuegen, nicht committen):
--
--   select vault.create_secret(
--     '<Wert des Edge-Secrets REVIEW_KEY>',
--     'REVIEW_KEY',
--     'Edge-Secret REVIEW_KEY, gelesen von pg_cron fuer den Artwork-Konflikt-Reminder'
--   );
--
-- Anwenden: gesamten Datei-Inhalt im SQL-Editor von ekiwwjzmiywaxvxdhzat ausfuehren.
-- Nochmal ausfuehren ersetzt den Job. Abschalten:
--   select cron.unschedule('artwork-conflict-reminder');

do $guard$
begin
  if not exists (
    select 1
    from vault.decrypted_secrets
    where name = 'REVIEW_KEY'
      and length(coalesce(decrypted_secret, '')) > 0
  ) then
    raise exception
      'Vault-Secret REVIEW_KEY fehlt oder ist leer. Zuerst den bestehenden Edge-Secret REVIEW_KEY unter genau diesem Namen in Vault ablegen. Den Wert nicht ins Repo schreiben.';
  end if;
end
$guard$;

select cron.unschedule(jobid)
from cron.job
where jobname = 'artwork-conflict-reminder';

select cron.schedule(
  'artwork-conflict-reminder',
  '0 7,8 * * *',
  $job$
  select net.http_post(
    url := 'https://ekiwwjzmiywaxvxdhzat.supabase.co/functions/v1/creative-review/remind?format=artworks',
    body := '{}'::jsonb,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-review-key', s.decrypted_secret
    ),
    timeout_milliseconds := 120000
  )
  from vault.decrypted_secrets s
  where s.name = 'REVIEW_KEY'
    and length(coalesce(s.decrypted_secret, '')) > 0
    and extract(hour from (now() at time zone 'Europe/Berlin')) = 9;
  $job$
);
