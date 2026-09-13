mod commands;
mod db;
mod import;
mod tags;

use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：应用驻留托盘时再次启动（如点桌面图标），
        // 会走到这个回调，直接唤出已有窗口而不是静默失败
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            use tauri::{Emitter, Manager};

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
                let _ = win.emit("quick-open", ());
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let conn = db::init().expect("failed to initialize database");
            app.manage(db::Db(std::sync::Mutex::new(conn)));

            #[cfg(desktop)]
            {
                use tauri_plugin_autostart::ManagerExt;
                use tauri_plugin_global_shortcut::{
                    Builder as ShortcutBuilder, Code, Modifiers, ShortcutState,
                };

                app.handle().plugin(
                    ShortcutBuilder::new()
                        .with_shortcuts(["ctrl+shift+m"])
                        .expect("failed to register global shortcut Ctrl+Shift+M")
                        .with_handler(|app, shortcut, event| {
                            if event.state == ShortcutState::Pressed
                                && shortcut.matches(Modifiers::CONTROL | Modifiers::SHIFT, Code::KeyM)
                            {
                                toggle_main_window(app);
                            }
                        })
                        .build(),
                )?;

                // 托盘：左键切换窗口，菜单提供 显示/隐藏、开机自启、退出
                let autostart_enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let toggle_item =
                    MenuItem::with_id(app, "toggle", "显示 / 隐藏 (Ctrl+Shift+M)", true, None::<&str>)?;
                let autostart_item = CheckMenuItem::with_id(
                    app,
                    "autostart",
                    "开机自启",
                    true,
                    autostart_enabled,
                    None::<&str>,
                )?;
                let quit_item = MenuItem::with_id(app, "quit", "退出 FMemos", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&toggle_item, &autostart_item, &quit_item])?;

                let autostart_handle = autostart_item.clone();
                TrayIconBuilder::with_id("main")
                    .icon(app.default_window_icon().expect("missing app icon").clone())
                    .tooltip("FMemos")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| match event.id.as_ref() {
                        "toggle" => toggle_main_window(app),
                        "autostart" => {
                            let launcher = app.autolaunch();
                            let next = match launcher.is_enabled() {
                                Ok(true) => {
                                    let _ = launcher.disable();
                                    false
                                }
                                _ => {
                                    let _ = launcher.enable();
                                    true
                                }
                            };
                            let _ = autostart_handle.set_checked(next);
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        } = event
                        {
                            toggle_main_window(tray.app_handle());
                        }
                    })
                    .build(app)?;
            }

            Ok(())
        })
        // 关闭窗口 = 隐藏到托盘，真正退出走托盘菜单的「退出」
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_memo,
            commands::list_memos,
            commands::update_memo,
            commands::delete_memo,
            commands::set_pin,
            commands::restore_memo,
            commands::purge_memo,
            commands::empty_trash,
            commands::rename_tag,
            commands::delete_tag,
            commands::export_text,
            commands::export_to,
            commands::get_setting,
            commands::set_setting,
            commands::open_backup_dir,
            commands::list_backups,
            commands::restore_backup,
            commands::import_path,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Ctrl+Shift+M / 托盘：窗口可见且聚焦时隐藏，否则呼出并聚焦；
/// 呼出时发 quick-open 事件，前端聚焦顶部输入框。
#[cfg(desktop)]
fn toggle_main_window(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false) {
        let _ = win.hide();
        return;
    }
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    let _ = win.emit("quick-open", ());
}
