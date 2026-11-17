ALTER TABLE `provider` ADD `status` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `provider` ADD `featured` integer;--> statement-breakpoint
ALTER TABLE `provider` ADD `platforms` text;--> statement-breakpoint
ALTER TABLE `provider` ADD `fee_usd` real;--> statement-breakpoint
ALTER TABLE `provider` ADD `per_minute` real;--> statement-breakpoint
ALTER TABLE `provider` ADD `connect_url` text;
--> statement-breakpoint
-- Runner clouds from the Nov 17 provider review, kept Hidden: recognised by their labels but not
-- offered until an operator makes them Live in Admin › Providers. Prices are list prices found
-- then, for a 2 vCPU Linux minute. INSERT OR IGNORE leaves any row an operator already saved.
INSERT OR IGNORE INTO `provider` (`id`, `name`, `summary`, `labels`, `prefixes`, `logo_url`, `status`, `platforms`, `fee_usd`, `per_minute`, `updated_by`, `updated_at`) VALUES
('avrea', 'Avrea', 'Hosted Linux, Linux arm, macOS and Windows runners for GitHub Actions.', 'avrea-*', '["avrea-"]', '/provider-logos/avrea.svg', 'hidden', '["x64", "arm", "mac", "win"]', 0, 0.004, 'provider review', 1794952800000),
('tenki', 'Tenki', 'Hosted Linux and macOS runners for GitHub Actions.', 'tenki-*', '["tenki-"]', '/provider-logos/tenki.svg', 'hidden', '["x64", "mac"]', 0, 0.004, 'provider review', 1794952800000),
('bitrise', 'Bitrise Build Hub', 'Hosted macOS runners for GitHub Actions.', 'bitrise-m4-pro', '["bitrise-"]', '/provider-logos/bitrise.svg', 'hidden', '["mac"]', NULL, NULL, 'provider review', 1794952800000),
('starsling', 'StarSling', 'Hosted Linux runners for GitHub Actions.', 'starsling-*', '["starsling-"]', '/provider-logos/starsling.svg', 'hidden', '["x64"]', 0, 0.004, 'provider review', 1794952800000),
('craci', 'CRACI', 'Hosted Linux and Linux arm runners for GitHub Actions.', 'craci', '["craci"]', '/provider-logos/craci.svg', 'hidden', '["x64", "arm"]', 0, 0.004, 'provider review', 1794952800000),
('shipfox', 'Shipfox', 'Hosted Linux runners for GitHub Actions.', 'shipfox-2cpu', '["shipfox-"]', '/provider-logos/shipfox.png', 'hidden', '["x64"]', 0, 0.004, 'provider review', 1794952800000),
('tempus', 'tempus.build', 'Hosted Linux runners for GitHub Actions.', 'tempus-ubuntu-24.04-2core', '["tempus-"]', '/provider-logos/tempus.png', 'hidden', '["x64"]', 0, 0.004, 'provider review', 1794952800000),
('monkci', 'Monk CI', 'Hosted Linux runners for GitHub Actions.', 'monkci-ubuntu-latest', '["monkci-"]', '/provider-logos/monkci.svg', 'hidden', '["x64"]', 0, 0.004, 'provider review', 1794952800000),
('latchkey', 'Latchkey', 'Hosted Linux runners for GitHub Actions.', 'latchkey-small', '["latchkey-"]', '/provider-logos/latchkey.png', 'hidden', '["x64"]', 5, 0.0025, 'provider review', 1794952800000),
('morph', 'Morph', 'Hosted Linux runners for GitHub Actions.', 'morph', '["morph"]', '/provider-logos/morph.png', 'off', '["x64"]', 0, 0.0025, 'provider review', 1794952800000),
('runloft', 'Runloft', 'Hosted Linux runners for GitHub Actions.', 'runloft-*', '["runloft-"]', '/provider-logos/runloft.svg', 'hidden', '["x64"]', 0, 0.003, 'provider review', 1794952800000),
('promigence', 'Promigence', 'Hosted Linux runners for GitHub Actions.', 'promigence', '["promigence"]', '/provider-logos/promigence.png', 'hidden', '["x64"]', 0, 0.0028, 'provider review', 1794952800000),
('vitko', 'Vitko', 'Hosted Linux runners for GitHub Actions.', 'vitko-ubuntu-24.04', '["vitko-"]', '/provider-logos/vitko.svg', 'hidden', '["x64"]', 0, 0.002, 'provider review', 1794952800000),
('berrybox', 'BerryBox', 'Hosted Linux runners for GitHub Actions.', 'berrybox-2vcpu-ubuntu-2404', '["berrybox-"]', '/provider-logos/berrybox.png', 'hidden', '["x64"]', 0, 0.002, 'provider review', 1794952800000),
('compilerdev', 'compiler.dev', 'Hosted Linux runners for GitHub Actions.', 'compiler-*', '["compiler-"]', '/provider-logos/compilerdev.svg', 'hidden', '["x64"]', 0, 0.002, 'provider review', 1794952800000),
('jog', 'Jog', 'Hosted Linux runners for GitHub Actions.', 'jog, jog-max', '["jog"]', '/provider-logos/jog.svg', 'hidden', '["x64"]', 0, 0.0012, 'provider review', 1794952800000),
('sengi', 'Sengi', 'Hosted Linux runners for GitHub Actions.', 'sengi-basic-2-ubuntu-2404', '["sengi-"]', '/provider-logos/sengi.png', 'hidden', '["x64"]', 0, 0.001, 'provider review', 1794952800000),
('machinedev', 'machine.dev', 'Hosted Linux and Linux arm runners for GitHub Actions.', 'machine/cpu=2/architecture=x64', '["machine/"]', '/provider-logos/machinedev.svg', 'hidden', '["x64", "arm"]', 0, 0.0007, 'provider review', 1794952800000),
('instabox', 'InstaBox', 'Hosted Linux runners for GitHub Actions.', 'instabox-small', '["instabox-"]', '/provider-logos/instabox.svg', 'hidden', '["x64"]', 0, 0.00028, 'provider review', 1794952800000),
('celesto', 'Celesto', 'Hosted Linux runners for GitHub Actions.', 'celesto', '["celesto"]', '/provider-logos/celesto.png', 'hidden', '["x64"]', 0, 0.00025, 'provider review', 1794952800000),
('lizard', 'Lizard', 'Hosted Linux runners for GitHub Actions.', 'lizard-*', '["lizard-"]', '/provider-logos/lizard.png', 'hidden', '["x64"]', 19, 0.00027, 'provider review', 1794952800000),
('runjob', 'RunJob', 'Hosted Linux runners for GitHub Actions.', 'runjob-ubuntu-latest', '["runjob-"]', '/provider-logos/runjob.png', 'hidden', '["x64"]', 0, NULL, 'provider review', 1794952800000),
('ffxf', 'FFxF', 'Hosted Linux runners for GitHub Actions.', 'ffxf-*', '["ffxf-"]', '/provider-logos/ffxf.png', 'hidden', '["x64"]', 0, NULL, 'provider review', 1794952800000),
('graphide', 'Graphide', 'Hosted Linux runners for GitHub Actions.', 'graphide-linux-x64-8', '["graphide-"]', '/provider-logos/graphide.svg', 'hidden', '["x64"]', NULL, NULL, 'provider review', 1794952800000),
('skipbox', 'Skipbox', 'Hosted Linux runners for GitHub Actions.', 'skipbox', '["skipbox"]', '/provider-logos/skipbox.svg', 'off', '["x64"]', 39, NULL, 'provider review', 1794952800000),
('nomac', 'NoMac CI', 'Hosted macOS runners for GitHub Actions.', 'nomac', '["nomac"]', '/provider-logos/nomac.png', 'hidden', '["mac"]', 0, NULL, 'provider review', 1794952800000),
('getmac', 'GetMac', 'Hosted macOS runners for GitHub Actions.', 'getmac', '["getmac"]', '/provider-logos/getmac.png', 'hidden', '["mac"]', 11.99, NULL, 'provider review', 1794952800000);
