-- Event logos are now kept at 1024px rather than 512px (EVENT_LOGO_SIZE in src/lib/tournament/logoImage.ts):
-- the front page draws them across the whole banner, and at 512 their small print went soft.
--
-- A 1024px WebP is a few hundred KB, comfortably under the bucket's 1 MB cap. But a browser that cannot
-- write WebP (Safari) saves a PNG instead, and a detailed 1024px PNG can pass 1 MB - which the bucket
-- would refuse, leaving an administrator with an upload that fails for no reason they can see. So the
-- cap goes to 3 MB. Nothing else about the bucket changes.
update storage.buckets set file_size_limit = 3145728 where id = 'event-logos';
