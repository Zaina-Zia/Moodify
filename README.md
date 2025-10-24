# 🎧 Moodify  
**Discover music that feels like you**  

<a href="https://moodify-tau-five.vercel.app/"> Access the project here! </a> 

---

## 🧠 Overview  
**Moodify** transforms how listeners explore music by generating playlists that align with their **current mood and listening patterns**.  
Rather than relying on generic recommendations, the app connects with **Spotify’s API** to craft playlists that reflect emotional states — whether the listener feels **relaxed, energetic, focused, or melancholic**.  

It’s not just another playlist generator — it’s a **personal listening companion** that understands and adapts to your vibe.

---

## 🌍 Impact and Vision  
Music plays a crucial role in **emotional regulation and personal expression**.  
Moodify strengthens this connection by combining **emotion-based filtering** with personalized Spotify data, helping users discover songs that **resonate with their mood**.  

The project demonstrates how technology can support **mental wellness, personalization, and creativity** by blending emotional intelligence with data-driven insights.  

✨ **Benefits:**  
- Reduces **decision fatigue**  
- Personalizes **music discovery**  
- Creates a more **meaningful listening experience**  

---

## ⚙️ Core Functionality  

### 🔐 Login and Access  
- Landing page provides a single **Spotify login** option.  
- Upon login, Moodify retrieves **top tracks, artists, and listening patterns** to generate a personalized playlist.  
- If the user **does not log in**, a **default playlist** is generated using predefined data.  
- Logged-in users can **add playlists directly** to their Spotify library.  
- Each playlist track includes a **preview option** before adding.

  <img width="799" height="766" alt="image" src="https://github.com/user-attachments/assets/56fd0308-9e81-4639-9611-625911c772d7" />


### ⚠️ Pre-Requisites for Spotify Login  
- If logging in with **Google**, the user’s Spotify account must support **Google authentication**.  
- The user’s **Gmail must be added** to the Spotify Developer Dashboard under the developer’s registered app for OAuth access.  
- Without this setup, **login and playlist creation** will not be authorized.  

---

### 🌐 Language and Mood Selection  
- **Languages Supported:** English and Urdu. 
- **Mood Categories:**  
  - 🎉 Happy  
  - 😢 Sad  
  - 🧊 Chill  
  - 🎯 Focused  
  - ⚡ Energetic  
  - 💞 Romantic  
- The interface visually adapts to match the selected emotion through dynamic colors and animations.  

<img width="724" height="466" alt="image" src="https://github.com/user-attachments/assets/13eb3f99-b19b-4769-97ee-82307f19f3ab" />


---

### 🎵 Playlist Generation  
- On clicking **Generate Playlist**, the app processes data in **15–20 seconds**.  
- The delay is caused by **real-time Spotify API calls**.  
- A **loading indicator** keeps the user informed.  
- The generated playlist displays as **track cards**, each showing:  
  - Song Title  
  - Artist Name  
  - Album Cover  
  - Preview Option  
  - *Add to Spotify* button  

<img width="1095" height="874" alt="image" src="https://github.com/user-attachments/assets/7517fd72-0275-4d80-b858-5525fb48cc5b" />
<img width="1055" height="859" alt="image" src="https://github.com/user-attachments/assets/bb3718e8-69b1-4215-b188-763ead99aa98" />

---

## 🚀 Key Features  
- 🎧 **Mood-Based Playlists** — Curated tracks tailored to emotional tone.  
- 🔗 **Spotify Integration** — Secure OAuth 2.0 authentication and playlist creation.  
- 🔍 **Smart Search** — Filter songs by artist, track, or genre within the chosen mood.  
- 🌐 **Multilingual Interface** — English, Urdu, and internal *B-word* support.  
- 📱 **Responsive Design** — Works seamlessly on desktop and mobile.  
- 🔄 **Dynamic Refresh** — Instantly updates playlists and visuals when moods change.  

---

## 🎨 Visual Experience  
- Subtle **gradients and color transitions** that reflect mood.  
- Clean, modern **typography** for readability.  
- Each song card includes:  
  - 🎵 Title  
  - 👤 Artist  
  - 💿 Album Cover  
  - ▶️ Quick Preview Controls  

---

## 🤖 LLM Disclosure  
This documentation and related descriptive text were developed with assistance from **WindSurf GPT-5 (Low Reasoning Model)**.

---

## 📝 Summary  
**Moodify** is a reliable, emotionally intelligent web app that personalizes your music experience by connecting your **mood** with **Spotify’s vast library**.  

While playlist generation currently takes around **15–20 seconds** and may benefit from future personalization updates, the system already delivers a **stable, accessible, and impactful** experience — effectively showcasing the integration of **emotional intelligence** with modern music technology.

---
