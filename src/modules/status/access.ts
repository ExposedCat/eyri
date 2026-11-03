export function getAdminId(value = Deno.env.get("ADMIN_ID")) {
  if (!value || !/^[1-9]\d*$/.test(value.trim())) return undefined;
  const id = Number(value.trim());
  return Number.isSafeInteger(id) ? id : undefined;
}
