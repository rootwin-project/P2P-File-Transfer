use wasm_bindgen::prelude::*;
use aes_gcm::{Aes256Gcm, KeyInit, aead::Aead};
use aes_gcm::aead::generic_array::GenericArray;
use pbkdf2::pbkdf2_hmac;
use sha2::Sha256;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use getrandom::getrandom;
use serde::{Serialize, Deserialize};

const APP_PEPPER: &[u8] = b"F1abD$29A";

#[derive(Serialize, Deserialize)]
struct Packet {
    e: String,
    p: String,
}

fn gen_password() -> String {
    let chars = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let mut arr = [0u8; 16];
    getrandom(&mut arr).unwrap();
    let mut password = String::with_capacity(16);
    for b in arr.iter() {
        password.push(chars[(*b as usize) % chars.len()] as char);
    }
    password
}

fn derive_key(password: &str, salt: &[u8]) -> [u8; 32] {
    // Эффективная соль = случайная соль из пакета + статичный pepper приложения.
    // Без знания APP_PEPPER восстановить ключ по перехваченному пакету
    // (даже если пароль и случайная соль известны) невозможно.
    let mut effective_salt = Vec::with_capacity(salt.len() + APP_PEPPER.len());
    effective_salt.extend_from_slice(salt);
    effective_salt.extend_from_slice(APP_PEPPER);

    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &effective_salt, 100_000, &mut key);
    key
}

#[wasm_bindgen]
pub fn pack_key(json_str: &str) -> Result<String, JsValue> {
    let password = gen_password();
    let mut salt = [0u8; 16];
    let mut iv = [0u8; 12];
    getrandom(&mut salt).map_err(|e| JsValue::from_str(&e.to_string()))?;
    getrandom(&mut iv).map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let key_bytes = derive_key(&password, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let mut iv_array = GenericArray::default();
    iv_array.copy_from_slice(&iv);
    
    let ciphertext = cipher.encrypt(&iv_array, json_str.as_bytes()).map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let mut buf = vec![0u8; 16 + 12 + ciphertext.len()];
    buf[0..16].copy_from_slice(&salt);
    buf[16..28].copy_from_slice(&iv);
    buf[28..].copy_from_slice(&ciphertext);
    
    let encrypted_b64 = BASE64.encode(&buf);
    let packet = Packet { e: encrypted_b64, p: password };
    let packet_json = serde_json::to_string(&packet).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(BASE64.encode(packet_json.as_bytes()))
}

#[wasm_bindgen]
pub fn unpack_key(b64: &str) -> Result<String, JsValue> {
    let packet_bytes = BASE64.decode(b64).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let packet_str = String::from_utf8(packet_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let packet: Packet = serde_json::from_str(&packet_str).map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let buf = BASE64.decode(&packet.e).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if buf.len() < 28 {
        return Err(JsValue::from_str("Invalid buffer length"));
    }
    let salt = &buf[0..16];
    let iv = &buf[16..28];
    let ciphertext = &buf[28..];
    
    let key_bytes = derive_key(&packet.p, salt);
    let cipher = Aes256Gcm::new_from_slice(&key_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    let mut iv_array = GenericArray::default();
    iv_array.copy_from_slice(iv);
    
    let decrypted_bytes = cipher.decrypt(&iv_array, ciphertext).map_err(|e| JsValue::from_str(&e.to_string()))?;
    
    String::from_utf8(decrypted_bytes).map_err(|e| JsValue::from_str(&e.to_string()))
}

#[wasm_bindgen]
pub fn encrypt_chunk(chunk: &[u8], key_bytes: &[u8], iv_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if iv_bytes.len() != 12 {
        return Err(JsValue::from_str("IV length must be 12"));
    }
    let iv = GenericArray::from_slice(iv_bytes);
    let ciphertext = cipher.encrypt(iv, chunk).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(ciphertext)
}

#[wasm_bindgen]
pub fn decrypt_chunk(encrypted_chunk: &[u8], key_bytes: &[u8], iv_bytes: &[u8]) -> Result<Vec<u8>, JsValue> {
    let cipher = Aes256Gcm::new_from_slice(key_bytes).map_err(|e| JsValue::from_str(&e.to_string()))?;
    if iv_bytes.len() != 12 {
        return Err(JsValue::from_str("IV length must be 12"));
    }
    let iv = GenericArray::from_slice(iv_bytes);
    let decrypted = cipher.decrypt(iv, encrypted_chunk).map_err(|e| JsValue::from_str(&e.to_string()))?;
    Ok(decrypted)
}