-- THE fix for "End match doesn't reset". `attacks` had no DELETE policy, and Postgres RLS
-- deletes zero rows *without raising an error* in that case - so the reset reported success
-- while every previous shot stayed on the board.
--
-- Verified empirically: before this policy, a host's delete returned no error and left all
-- rows in place; after it, the rows are actually removed.
drop policy if exists "attacks delete" on attacks;
create policy "attacks delete" on attacks for delete using (true);
