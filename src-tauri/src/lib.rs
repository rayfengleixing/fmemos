mod commands;
mod db;
mod tags;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let conn = db::init().expect("failed to initialize database");
            app.manage(db::Db(std::sync::Mutex::new(conn)));

            #[cfg(desktop)]
            {
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
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::create_memo,
            commands::list_memos,
            commands::update_memo,
            commands::delete_memo,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Ctrl+Shift+M：窗口可见且聚焦时隐藏，否则呼出并聚焦；
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
