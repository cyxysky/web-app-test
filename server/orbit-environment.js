// Public host settings accept the Orbit prefix while legacy consumers keep working.
// Internal process credentials and role flags are deliberately not aliases.
const settingNames = [
  'ADMIN_SETTINGS_PASSWORD', 'ADMIN_SETTINGS_PASSWORD_ENABLED', 'APP_DIR',
  'BASE_PATH', 'BRAND_PREFIX', 'BRAND_TEXT', 'CAPABILITY_SOURCE', 'CROSS_SITE_MOUNT',
  'DEBUG_ROUTES_ENABLED', 'DEBUG_WEBPACK_CACHE', 'DEFAULT_USER_ID',
  'DEV_MEMORY_RESTART', 'DEV_MEMORY_RESTART_THRESHOLD', 'DOCUMENT_FONT', 'DOCUMENT_FONT_FAMILY',
  'ELECTRON_CDP_PORT', 'ELECTRON_SERVER_URL', 'REQUIRE_MOUNT_USER_ID',
  'RUNTIME_PORT', 'SERVER_ROOT', 'SPLIT_RUNTIME', 'TRUST_PROXY', 'WEBSOCKET_TICKET_TTL_SECONDS',
];

function applyOrbitEnvironment(environment = process.env) {
  const updates = {};
  for (const name of settingNames) {
    const value = environment[`ORBIT_${name}`];
    if (value !== undefined) {
      environment[`WEBPILOT_${name}`] = value;
      updates[`WEBPILOT_${name}`] = value;
    }
  }
  return updates;
}

module.exports = { applyOrbitEnvironment };
