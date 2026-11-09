// Host capability table — vendored from Kage's
// `ui/js/shared/extension-permissions.js` so we can statically check
// extension correctness without a network round-trip during CI.
//
// SYNC SOURCE:
//   https://github.com/nachmore/Kage/blob/main/ui/js/shared/extension-permissions.js
//
// When the host adds, renames, or splits a capability, mirror the
// change here in the same commit. The host's `COMMAND_CAPABILITIES`
// is the authority — drift means an extension might pass our checks
// here but get rejected at runtime, or vice versa. There's a CI test
// (scripts/check-host-sync.mjs, run on schedule) that fetches the
// upstream file and warns on divergence.

/**
 * Tauri command name → capability that gates it. `null` means "never
 * callable from an extension."
 *
 * Keep entries grouped + commented in the same style as the host file
 * so a side-by-side diff during sync stays trivial.
 */
export const COMMAND_CAPABILITIES = Object.freeze({
    // --- storage --------------------------------------------------------
    // Never extension-callable: returns the ENTIRE app config (other
    // extensions' data, grants, connection commands). See the host file
    // for the full rationale.
    get_config: null,
    get_extension_config: 'storage',
    save_extension_config: 'storage',
    save_extension_data: 'storage',
    load_extension_data: 'storage',
    delete_extension_data: 'storage',
    // Kage-internal global launcher state — not identity-scoped.
    save_frecency: null,
    load_frecency: null,

    // --- clipboard ------------------------------------------------------
    read_clipboard: 'clipboard',
    get_clipboard_history: 'clipboard',
    // Host-only: writes text + synthesises Ctrl+V into the focused app
    // (keystroke injection), so the host maps it to null.
    paste_clipboard_item: null,

    // --- urls / launch (the post-`shell` split) ------------------------
    open_url: 'urls',
    open_path: 'launch',
    launch_app_by_name: 'launch',

    // --- oauth ---------------------------------------------------------
    oauth_loopback_start: 'oauth',
    oauth_loopback_await: 'oauth',
    oauth_loopback_cancel: 'oauth',

    // --- network -------------------------------------------------------
    fetch_favicon: 'network',
    fetch_link_metadata: 'network',

    // --- filesystem ----------------------------------------------------
    pick_folder: 'filesystem',
    scan_folder: 'filesystem',
    // Host-only: moves/renames/trashes files — beyond `filesystem`'s
    // discovery promise. Only the agent's MCP path uses it.
    execute_folder_plan: null,
    get_common_folders: 'filesystem',
    search_files: 'filesystem',
    resolve_directories: 'filesystem',

    // --- window (Kage chrome) ------------------------------------------
    resize_floating_window: 'window',
    set_floating_opacity: 'window',
    start_drag_window: 'window',
    save_window_position: 'window',
    save_chat_window_geometry: 'window',
    apply_chat_window_size: 'window',

    // --- windows (other apps) ------------------------------------------
    list_open_windows: 'windows',
    get_window_icons: 'windows',
    focus_open_window: 'windows',
    get_process_name: 'windows',
    get_source_window: 'windows',
    get_app_icon: 'windows',

    // --- notifications -------------------------------------------------
    notify_frontend_ready: 'notifications',
    // App-internal completion toast — never extension-callable.
    notify_response_ready: null,

    // --- calendar ------------------------------------------------------
    get_calendar_events: 'calendar',
    get_calendar_events_for_date: 'calendar',
    // Per-day event counts for the host date picker's busy-day dots.
    get_calendar_busy_days: 'calendar',

    // --- session -------------------------------------------------------
    list_sessions: 'session',
    load_session: 'session',
    get_window_session: 'session',
    get_sessions_directory: 'session',
    get_session_stream_snapshot: 'session',

    // --- agent ---------------------------------------------------------
    send_message_streaming: 'agent',
    cancel_generation: 'agent',
    send_steering_message: 'agent',
    // Host-only: the backend replays the latest block into every
    // session, so only the host's extension-tool-controller sends it.
    send_extension_tool_steering: null,
    extension_tool_response: 'agent',
    open_chat_with_message: 'agent',
    get_available_models: 'agent',
    get_slash_commands: 'agent',

    // --- activity -----------------------------------------------------
    start_activity_tracker: 'activity',
    stop_activity_tracker: 'activity',
    get_activity_report: 'activity',
    is_activity_tracker_running: 'activity',

    // --- automation --------------------------------------------------
    emit_automation_signal: 'automation',
    list_automation_signals: 'automation',
    get_power_status: 'automation',

    // --- tts ---------------------------------------------------------
    pocket_tts_test: 'tts',
    pocket_tts_voices: 'tts',

    // --- file_text (Kage docs/design/EXTENSION_FILE_TEXT.md §3.5) ------
    // The host force-injects `extensionId` (and `displayName` for
    // pick_file_text). Code that calls `context.files` instead of
    // invoke() adds a `// permissions: file_text` hint.
    pick_file_text: 'file_text',
    cancel_file_text: 'file_text',
    file_text_support: 'file_text',

    // --- agent_background (EXTENSION_AGENT_CALLS.md §3.5) -------------
    // Code that calls `context.agent` instead of invoke() adds a
    // `// permissions: agent_background` hint.
    agent_call_reserve: 'agent_background',
    agent_call_ready: 'agent_background',
    agent_call_send: 'agent_background',
    agent_call_cancel: 'agent_background',
    agent_call_status: 'agent_background',

    // --- sync (SYNC.md §12.3) -----------------------------------------
    // Code that calls `context.sync` instead of invoke() adds a
    // `// permissions: sync` hint.
    ext_sync_status: 'sync',
    ext_sync_push: 'sync',
    ext_sync_pull: 'sync',
    ext_sync_ack: 'sync',

    // --- views (EXTENSION_VIEWS.md §5) --------------------------------
    // No command maps to `views`: the capability gates host behaviour
    // (the `open_view` action and effect). The ext_view_* commands below
    // are first-party only. Code that returns an `open_view` action adds
    // a `// permissions: views` hint.

    // --- explicitly forbidden ----------------------------------------
    // Commands that exist in the host but are never callable from an
    // extension. Listed here so the analysis script can distinguish
    // "you typo'd this command name" from "this is a real host command
    // that's intentionally off-limits."
    save_config: null,
    quit_app: null,
    restart_app: null,
    execute_system_command: null,
    install_extension_from_path: null,
    uninstall_extension: null,
    welcome_provision_extensions: null,
    remove_tool_permission: null,
    update_tool_policy: null,
    send_permission_response: null,
    read_extension_file: null,
    open_devtools: null,
    dump_thread_info: null,
    app_log_write: null,
    app_log_get_entries: null,
    app_log_clear: null,
    app_log_get_dir: null,
    save_mcp_config: null,
    get_mcp_config: null,
    get_mcp_json_path: null,
    set_startup_enabled: null,
    set_computer_control_enabled: null,
    check_for_update: null,
    download_and_install_update: null,
    clear_update_flag: null,
    telemetry_track: null,
    get_telemetry_info: null,
    set_telemetry_enabled: null,
    reset_telemetry_install_id: null,
    pocket_tts_install: null,
    pocket_tts_cancel_install: null,
    pocket_tts_start: null,
    pocket_tts_stop: null,
    execute_automation_plan: null,
    execute_macro: null,
    execute_shortcut: null,
    inline_assist_apply: null,
    send_inline_assist: null,
    show_inline_assist: null,
    complete_first_run: null,
    trigger_welcome_banner: null,
    capture_hotkey_combo: null,
    cancel_hotkey_capture: null,
    try_register_hotkey: null,
    reconnect_acp: null,
    switch_acp_session: null,
    rename_session: null,
    delete_session: null,
    reveal_session_file: null,
    check_connection: null,
    is_dev_mode: null,
    is_terminator_mode: null,
    is_first_run: null,
    was_just_updated: null,
    get_computer_control_enabled: null,
    get_startup_enabled: null,
    get_app_info: null,
    get_os_dark_mode: null,
    get_i18n_catalog: null,
    get_available_languages: null,
    set_language: null,
    read_extension_locale: null,
    detect_agents: null,
    list_agent_presets: null,
    validate_agent_connection: null,
    probe_connection_version: null,
    check_npm_available: null,
    install_acp_wrapper: null,
    agent_session_providers: null,
    agent_list_sessions: null,
    agent_load_session: null,
    agent_check_session_updated: null,
    open_chat_window: null,
    open_settings_window: null,
    // Host-internal surfaces added upstream — never extension-callable.
    generate_script: null,
    get_hotkey_registration_failures: null,
    kiro_desktop_delete_session: null,
    kiro_desktop_open_folder: null,
    kiro_desktop_workspaces: null,
    open_welcome_window: null,
    open_store_window: null,
    open_auto_steering_file: null,
    read_steering_lines: null,
    write_steering_lines: null,
    import_steering_lines: null,
    ollama_probe: null,
    ollama_list_models: null,
    ollama_codex_spawn_command: null,
    match_context_rule: null,
    export_config_default_filename: null,
    export_config_bundle: null,
    import_config_bundle: null,
    write_text_file: null,
    get_recent_crash: null,
    dismiss_recent_crash: null,
    show_context_menu: null,
    test_floating_window: null,
    handle_floating_input: null,
    set_window_session: null,
    clear_window_session: null,
    open_new_chat_window: null,
    close_chat_window: null,
    list_chat_windows: null,
    touch_floating_activity: null,
    get_last_selection: null,
    list_extensions: null,
    list_themes: null,
    list_command_packs: null,
    load_theme_colors: null,
    set_extension_enabled: null,
    commit_extension_install: null,
    remove_extension_grant: null,
    check_extension_updates: null,
    store_get_catalog: null,
    store_get_detail: null,
    store_install: null,
    save_store_url: null,
    get_permission_audit_log: null,
    get_permission_audit_log_path: null,
    clear_permission_audit_log: null,
    dismiss_pending_permission: null,
    has_pending_permission: null,
    check_extension_tool_permission: null,
    get_user_info: null,
    get_screen_context: null,
    get_steering_content: null,
    get_auto_steering_path: null,
    execute_slash_command: null,
    get_slash_command_options: null,
    fetch_changelog: null,
    get_update_urls: null,
    pocket_tts_check_install: null,
    record_shortcut_usage: null,
    get_shortcut_history: null,
    link_metadata_clear_cache: null,
    link_metadata_cache_stats: null,
    get_frecency_key: null,
    internal_sites_probe: null,
    internal_sites_test: null,
    internal_sites_draft_rules: null,
    internal_sites_draft_script: null,
    present_overlay_window: null,
    set_tool_kind_trusted: null,
    set_mcp_server_trusted: null,
    approve_permissions_if_allowed: null,
    begin_hotkey_recording: null,
    end_hotkey_recording: null,
    check_system_shortcut_conflicts: null,
    allow_system_shortcut_override: null,
    get_privacy_permissions: null,
    repair_privacy_permission: null,
    preview_config_export: null,
    get_pending_context_menu: null,
    context_menu_ready: null,
    hide_context_menu: null,
    launcher_result_actions: null,
    launcher_result_action: null,
    spell_suggestions: null,
    learn_spelling: null,
    // Host-only commands of the four designs in Kage's docs/design/
    // (SYNC.md §23.3: every command they add that isn't listed above
    // maps to null). Extension views (EXTENSION_VIEWS.md §16.1):
    ext_view_open: null,
    ext_view_boot: null,
    ext_view_compose: null,
    ext_view_copy_text: null,
    ext_view_focus_state: null,
    ext_view_list: null,
    ext_view_reset_geometry: null,
    // Background agent calls, settings panel (EXTENSION_AGENT_CALLS.md §3.6):
    get_extension_agent_access: null,
    set_extension_agent_access: null,
    stop_extension_agent_calls: null,
    get_extension_agent_request_detail: null,
    // Folder sync (SYNC.md §19.5):
    get_config_snapshot: null,
    sync_get_status: null,
    sync_suggest_folders: null,
    sync_inspect_folder: null,
    sync_generate_passphrase: null,
    sync_create: null,
    sync_join: null,
    sync_confirm_join: null,
    sync_unlock: null,
    sync_set_paused: null,
    sync_now: null,
    sync_set_category: null,
    sync_set_extension_data: null,
    sync_get_scopes: null,
    sync_set_scope: null,
    sync_list_conflicts: null,
    sync_conflict_detail: null,
    sync_resolve_conflict: null,
    sync_dismiss_all: null,
    sync_list_reviews: null,
    sync_approve_runnable: null,
    sync_keep_off: null,
    sync_dismiss_suggestion: null,
    sync_answer_mass_change: null,
    sync_list_devices: null,
    sync_rename_device: null,
    sync_prepare_destructive: null,
    sync_remove_device: null,
    sync_change_passphrase: null,
    sync_leave: null,
    sync_start_over: null,
    sync_undo_join: null,
    sync_purge_extension: null,
    sync_find_folder: null,
});

/**
 * Capability metadata. The host uses this for the install prompt and
 * settings badge row; we use the keys here as the canonical
 * KNOWN_CAPABILITIES set for manifest validation.
 */
export const CAPABILITIES = Object.freeze({
    storage: { icon: '💾', label: 'Storage' },
    clipboard: { icon: '📋', label: 'Clipboard' },
    urls: { icon: '🔗', label: 'Open links' },
    launch: { icon: '🚀', label: 'Launch apps & open files' },
    network: { icon: '📡', label: 'Network access' },
    oauth: { icon: '🔐', label: 'OAuth sign-in' },
    filesystem: { icon: '📂', label: 'Filesystem' },
    window: { icon: '🪟', label: 'Kage windows' },
    windows: { icon: '🧿', label: 'Open windows' },
    notifications: { icon: '🔔', label: 'Notifications' },
    calendar: { icon: '📅', label: 'Calendar' },
    session: { icon: '💬', label: 'Chat sessions' },
    agent: { icon: '🤖', label: 'AI agent' },
    activity: { icon: '📊', label: 'Activity' },
    automation: { icon: '⚡', label: 'Automation' },
    tts: { icon: '🔈', label: 'Text-to-speech' },
    // The four designs in Kage's docs/design/ (SYNC.md §23.3).
    views: { icon: '🖼️', label: 'Its own windows' },
    file_text: { icon: '📄', label: 'Files you choose' },
    agent_background: { icon: '🌙', label: 'Background AI' },
    sync: { icon: '🔄', label: 'Sync between your computers' },
});

/** Stable ordered list of capability names. */
export const KNOWN_CAPABILITIES = Object.freeze(Object.keys(CAPABILITIES));

/**
 * Closed vocabulary of mascot activity hints.
 *
 * An extension tells the mascot what KIND of thing is happening via
 * `context.mascot?.setActivity?.(name, { ttlMs })`, and must declare every
 * name it may emit in `contributes.mascotActivities` — the host drops
 * undeclared ones. The names are deliberately generic: Spotify emits
 * `music`, not `spotify`, because the mascot knows nothing about individual
 * extensions. Anything outside this list is ignored at runtime.
 *
 * SYNC SOURCE:
 *   https://github.com/nachmore/Kage/blob/main/ui/js/shared/extension-sandbox-host.js
 *   (`MASCOT_ACTIVITIES`)
 */
export const MASCOT_ACTIVITIES = Object.freeze(['music', 'meeting', 'timer']);

/**
 * Bounds the host clamps `setActivity`'s `ttlMs` into. The hint is a LEASE:
 * it expires, so an extension re-asserts it on every refresh cycle while the
 * state holds and calls `clearActivity()` when it stops. That's what makes a
 * crashed, disabled or hidden extension unable to pin the mascot. Vendored
 * here so docs and checks can quote the real numbers.
 */
export const MASCOT_TTL_MIN_MS = 15_000;
export const MASCOT_TTL_MAX_MS = 600_000;

/**
 * Compute the minimal capability set an extension actually uses, given
 * the set of `invoke('cmd', ...)` command names found in its source.
 * Unknown / null-mapped commands are silently dropped — they're either
 * forbidden (host blocks them) or not in scope for cap analysis.
 */
export function capabilitiesUsedByCommands(commandNames) {
    const caps = new Set();
    for (const name of commandNames) {
        const required = COMMAND_CAPABILITIES[name];
        if (typeof required === 'string') caps.add(required);
    }
    return caps;
}

/**
 * Commands that exist in the host's COMMAND_CAPABILITIES table but are
 * not callable from an extension (mapped to `null`). Useful for telling
 * the user "this command exists but is forbidden for extensions" vs.
 * "this command name doesn't exist at all."
 */
export const FORBIDDEN_COMMANDS = Object.freeze(
    new Set(
        Object.entries(COMMAND_CAPABILITIES)
            .filter(([, cap]) => cap === null)
            .map(([name]) => name)
    )
);
