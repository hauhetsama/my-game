# 🃏 Yalancılar Barı — Kurulum Rehberi

## Gereksinimler
- [Node.js](https://nodejs.org) (v16 veya üzeri)

---

## 1. Kurulum

Dosyaları bir klasöre çıkar, sonra terminali o klasörde aç:

```bash
npm install
```

---

## 2. Sunucuyu Başlat

```bash
npm start
```

Terminalde şunu göreceksin:
```
🎴 Liar's Bar sunucusu çalışıyor: http://localhost:3000
```

---

## 3. Nasıl Oynanır?

### Aynı ağda (Wi-Fi) oynuyorsanız:
1. Sunucuyu başlat (`npm start`)
2. Kendi IP adresini bul:
   - Windows: `ipconfig` → "IPv4 Address"
   - Mac/Linux: `ifconfig` veya `ip addr`
3. Arkadaşlarına `http://192.168.x.x:3000` adresini gönder
4. Sen de `http://localhost:3000` ile gir

### İnternet üzerinden oynuyorsanız (ngrok):
```bash
# Ayrı bir terminalde:
npx ngrok http 3000
```
ngrok sana bir link verir (örn: `https://abc123.ngrok.io`)  
Bu linki arkadaşlarına gönder, hepsi oradan katılır.

---

## 4. Oyun Kuralları

| Eylem | Açıklama |
|-------|----------|
| **Kart Oyna** | Seçtiğin kartları ortaya koy, kaç tane koz oynadığını iddia et |
| **Yalancı!** | Önceki oyuncunun blöf yaptığını düşünüyorsan bunu seç |

**Blöf yakalanırsa** → Blöf yapan 1 can kaybeder  
**Haksız suçlama** → Suçlayan 1 can kaybeder  
**3 can biten oyuncu** → Elenir  
**Son kalan oyuncu** → Kazanır!

---

## 5. Notlar

- Maksimum 6 oyuncu
- Minimum 2 oyuncu (başlatmak için)
- Oyun ortasında bağlantısı kesilen oyuncu otomatik elenir
- Her yeni el sonrası koz değişir
