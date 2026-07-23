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
    paste_clipboard_item: 'clipboard',

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
    execute_folder_plan: 'filesystem',
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

    // --- calendar ------------------------------------------------------
    get_calendar_events: 'calendar',
    get_calendar_events_for_date: 'calendar',

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
    send_extension_tool_steering: 'agent',
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
    kage_desktop_delete_session: null,
    kage_desktop_open_folder: null,
    kage_desktop_workspaces: null,
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
});

/** Stable ordered list of capability names. */
export const KNOWN_CAPABILITIES = Object.freeze(Object.keys(CAPABILITIES));

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
