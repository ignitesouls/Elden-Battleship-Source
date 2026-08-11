-- Admins may correct the clock on an archived shot.
--
-- Deleting a mismarked shot was already possible ("match_events delete by admin"), but deletion is
-- the wrong tool for the common case: the square WAS killed, the mark just landed at the wrong
-- moment. Deleting it erases a real kill from the Almanac to fix a timestamp; there was no way to
-- simply move it, because match_events had no UPDATE policy at all.
--
-- Everything downstream of match_seconds is derived at read time - the timing and streak records
-- (recordBook.archivedShots), the Almanac's per-boss times, the replay's ordering - so moving a row
-- corrects all of them at once with no stored counter to walk back. That is why this is an UPDATE
-- policy and not a function: nothing else has to happen.
--
-- What it grants, stated plainly: an admin can update ANY column of any match_events row, which is
-- wider than the one field the UI edits. Same footing as the existing delete policy - an admin who
-- wanted to falsify a record could already delete it - and INSERT stays closed to everyone, so
-- archive_match() remains the only way a row is born.
drop policy if exists "match_events update by admin" on public.match_events;

create policy "match_events update by admin" on public.match_events
  for update using (public.is_admin()) with check (public.is_admin());
