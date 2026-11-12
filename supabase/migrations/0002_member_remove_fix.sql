-- `return found` read the result of the *second* statement, not the membership
-- delete, so an owner removing a member got `false` and the API answered 403
-- even though the row was gone. Capture the count where it happens.

create or replace function public.teams_api_member_remove(p_actor uuid, p_team uuid, p_member uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
as $$
declare
  v_owner uuid;
  v_removed integer;
begin
  select owner_id into v_owner from teams.team where id = p_team;
  if v_owner is null then
    return false;
  end if;
  -- A member may remove themselves; only an owner may remove someone else.
  if p_member <> p_actor and v_owner <> p_actor then
    return false;
  end if;
  if p_member = v_owner then
    return false;
  end if;

  delete from teams.membership where team_id = p_team and account_id = p_member;
  get diagnostics v_removed = row_count;

  delete from teams.usage_day where team_id = p_team and account_id = p_member;
  return v_removed > 0;
end;
$$;

revoke all on function public.teams_api_member_remove(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.teams_api_member_remove(uuid, uuid, uuid) to service_role;
