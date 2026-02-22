// server.js (第14弾：完全無圧縮・フル展開版)
require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ==========================================
// Gemini APIの準備
// ==========================================
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ 
  model: "gemini-1.5-pro" 
}); 

// ユーザーがアクセスした時に index.html を返す
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// ブラウザから要求されたら style.css を返す設定
app.get('/style.css', (req, res) => {
  res.sendFile(__dirname + '/style.css');
});

// ==========================================
// ゲームの全体状態を管理する変数群
// ==========================================
const rooms = {};

function initRoom(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = {
      cards: [],
      players: [],
      scores: {},
      turnIndex: 0,
      currentTheme: "待機中",
      currentPairs: 6,
      gameMode: "online",
      currentCpuLevel: "normal",
      cpuMemory: {}
    };
  }
  return rooms[roomName];
}

// ==========================================
// カードを準備する共通関数
// ==========================================
function setupCards(room, imageList, pairsCount) {
  room.cards = [];
  
  const selected = imageList.slice(0, pairsCount);
  
  const pairs = [...selected, ...selected];
  
  pairs.sort(() => {
    return Math.random() - 0.5;
  });
  
  pairs.forEach((url, index) => {
    room.cards.push({ 
      id: index, 
      val: url, 
      isOpen: false, 
      isMatched: false 
    });
  });
}

// ==========================================
// CPUが自動でカードをめくる高度な処理
// ==========================================
function playCPUTurn(roomName) {
  let room = rooms[roomName];
  
  if (!room) {
    return;
  }
  
  if (room.players[room.turnIndex] !== 'CPU') {
    return;
  }

  setTimeout(() => {
    room = rooms[roomName];
    
    if (!room) {
      return;
    }

    const closedCards = room.cards.filter((c) => {
      return !c.isOpen && !c.isMatched;
    });

    if (closedCards.length < 2) {
      return;
    }

    let useMemoryChance = 0;
    
    if (room.currentCpuLevel === 'hard') {
      useMemoryChance = 1.0; 
    } else if (room.currentCpuLevel === 'normal') {
      useMemoryChance = 0.5; 
    } else {
      useMemoryChance = 0.0; 
    }

    let card1 = null;
    let card2 = null;
    let knownPair = null;

    if (Math.random() < useMemoryChance) {
      let valueMap = {};
      
      for (let id in room.cpuMemory) {
        let c = room.cards.find((card) => {
          return card.id === parseInt(id);
        });
        
        if (c && !c.isOpen && !c.isMatched) {
          if (valueMap[c.val]) {
            knownPair = [valueMap[c.val], c];
            break;
          } else {
            valueMap[c.val] = c;
          }
        }
      }
    }

    if (knownPair) {
      card1 = knownPair[0];
      card2 = knownPair[1];
    } else {
      closedCards.sort(() => {
        return Math.random() - 0.5;
      });
      card1 = closedCards[0];

      let memoryMatch = null;
      
      if (Math.random() < useMemoryChance) {
        for (let id in room.cpuMemory) {
          let c = room.cards.find((card) => {
            return card.id === parseInt(id);
          });
          
          if (c && !c.isOpen && !c.isMatched && c.id !== card1.id && c.val === card1.val) {
            memoryMatch = c;
            break;
          }
        }
      }

      if (memoryMatch) {
        card2 = memoryMatch;
      } else {
        card2 = closedCards[1];
      }
    }

    room.cpuMemory[card1.id] = card1.val;
    room.cpuMemory[card2.id] = card2.val;

    card1.isOpen = true;
    
    io.to(roomName).emit('update_game', { 
      cards: room.cards, 
      scores: room.scores, 
      currentTurn: room.players[room.turnIndex], 
      players: room.players, 
      theme: room.currentTheme 
    });

    setTimeout(() => {
      room = rooms[roomName];
      
      if (!room) {
        return;
      }

      card2.isOpen = true;
      
      io.to(roomName).emit('update_game', { 
        cards: room.cards, 
        scores: room.scores, 
        currentTurn: room.players[room.turnIndex], 
        players: room.players, 
        theme: room.currentTheme 
      });

      if (card1.val === card2.val) {
        card1.isMatched = true; 
        card2.isMatched = true;
        room.scores['CPU'] += 1; 
        
        io.to(roomName).emit('match_result', { 
          msg: `💻 CPU(${room.currentCpuLevel}) が正解しました！`, 
          success: true 
        });
        
        io.to(roomName).emit('update_game', { 
          cards: room.cards, 
          scores: room.scores, 
          currentTurn: room.players[room.turnIndex], 
          players: room.players, 
          theme: room.currentTheme 
        });

        const isGameOver = room.cards.every((c) => {
          return c.isMatched;
        });

        if (isGameOver) {
          checkGameOver(roomName);
        } else {
          playCPUTurn(roomName);
        }
      } else {
        io.to(roomName).emit('match_result', { 
          msg: "💻 CPUはハズレ！", 
          success: false 
        });
        
        setTimeout(() => {
          room = rooms[roomName];
          
          if (!room) {
            return;
          }

          card1.isOpen = false; 
          card2.isOpen = false;
          
          room.turnIndex = (room.turnIndex + 1) % room.players.length;
          
          io.to(roomName).emit('update_game', { 
            cards: room.cards, 
            scores: room.scores, 
            currentTurn: room.players[room.turnIndex], 
            players: room.players, 
            theme: room.currentTheme 
          });
        }, 1500); 
      }
    }, 1000); 
  }, 1000); 
}

// ==========================================
// ゲーム終了時の結果判定
// ==========================================
function checkGameOver(roomName) {
  let room = rooms[roomName];
  
  if (!room) {
    return;
  }

  const p1 = room.players[0]; 
  const p2 = room.players[1];
  let winner = null;
  
  if (room.scores[p1] > room.scores[p2]) {
    winner = p1;
  } else if (room.scores[p2] > room.scores[p1]) {
    winner = p2;
  }

  setTimeout(() => { 
    io.to(roomName).emit('game_over', { 
      winner: winner, 
      scores: room.scores, 
      players: room.players, 
      gameMode: room.gameMode 
    }); 
  }, 500);
}

// ==========================================
// ユーザーが接続してきたときの処理
// ==========================================
io.on('connection', (socket) => {
  console.log('接続されました。ID:', socket.id);

  socket.on('play_again', () => {
    const roomName = socket.roomName;
    
    if (!roomName) {
      return;
    }
    
    if (!rooms[roomName]) {
      return;
    }
    
    let room = rooms[roomName];

    room.cards.forEach((c) => {
      c.isOpen = false;
      c.isMatched = false;
    });

    let values = room.cards.map((c) => {
      return c.val;
    });
    
    values.sort(() => {
      return Math.random() - 0.5;
    });
    
    room.cards.forEach((c, index) => {
      c.val = values[index];
      c.id = index;
    });

    room.players.forEach((id) => { 
      room.scores[id] = 0; 
    });
    
    room.turnIndex = 0;
    room.cpuMemory = {};

    io.to(roomName).emit('game_started');
    io.to(roomName).emit('update_game', { 
      cards: room.cards, 
      scores: room.scores, 
      currentTurn: room.players[room.turnIndex], 
      players: room.players, 
      theme: room.currentTheme 
    });
  });


  socket.on('request_ai_theme', async (data) => {
    const userTheme = data.theme;
    const pairsCount = parseInt(data.pairs);
    const gameMode = data.mode; 
    
    let cpuLevel = "normal";
    if (data.cpuLevel) {
      cpuLevel = data.cpuLevel;
    }
    
    let requestedRoom = data.roomName;
    if (!requestedRoom || requestedRoom === "") {
      requestedRoom = "default_room";
    }

    let roomName = requestedRoom;
    if (gameMode === 'cpu' || gameMode === 'local') {
      roomName = socket.id;
    }

    socket.join(roomName);
    socket.roomName = roomName;

    let room = initRoom(roomName);
    room.gameMode = gameMode;
    room.currentPairs = pairsCount;
    room.currentCpuLevel = cpuLevel;
    room.currentTheme = userTheme;

    if (gameMode === 'cpu') {
      room.players = [socket.id, 'CPU'];
      room.scores[socket.id] = 0;
      room.scores['CPU'] = 0;
      
    } else if (gameMode === 'local') {
      room.players = [socket.id + '_P1', socket.id + '_P2'];
      room.scores[socket.id + '_P1'] = 0;
      room.scores[socket.id + '_P2'] = 0;
      
    } else {
      if (!room.players.includes(socket.id)) {
        if (room.players.length < 2) {
          room.players.push(socket.id);
          room.scores[socket.id] = 0;
        } else {
          socket.emit('ai_status', "この合言葉の部屋は満員です！別の合言葉に変えてね。");
          return;
        }
      }

      const isGameOver = room.cards.length > 0 && room.cards.every((c) => {
        return c.isMatched;
      });

      if (isGameOver) {
        room.cards.forEach((c) => {
          c.isOpen = false;
          c.isMatched = false;
        });
        
        let values = room.cards.map((c) => { 
          return c.val; 
        });
        
        values.sort(() => { 
          return Math.random() - 0.5; 
        });
        
        room.cards.forEach((c, index) => {
          c.val = values[index];
          c.id = index;
        });
        
        room.players.forEach((id) => { 
          room.scores[id] = 0; 
        });
        
        room.turnIndex = 0;
        room.cpuMemory = {};
      }

      if (room.cards.length > 0) {
        socket.emit('ai_status', "部屋に参加しました！ゲームスタート！");
        socket.emit('game_started');
        io.to(roomName).emit('update_game', { 
          cards: room.cards, 
          scores: room.scores, 
          currentTurn: room.players[room.turnIndex], 
          players: room.players, 
          theme: room.currentTheme 
        });
        return; 
      }
    }

    console.log(`部屋[${roomName}] で生成開始`);
    io.to(roomName).emit('ai_status', `カードを準備しています...`);

    let aiImageUrls = [];

    if (userTheme === "トランプ" || userTheme === "カード") {
      const suits = ['S','H','D','C'];
      const ranks = ['A','2','3','4','5','6','7','8','9','0','J','Q','K'];
      let deck = [];
      
      suits.forEach((s) => {
        ranks.forEach((r) => {
          deck.push(r + s);
        });
      });
      
      deck.sort(() => {
        return Math.random() - 0.5;
      });
      
      for (let i = 0; i < pairsCount; i++) {
        let cardCode = deck[i % deck.length]; 
        aiImageUrls.push(`https://deckofcardsapi.com/static/img/${cardCode}.png`);
      }
    }
    else if (userTheme === "風景" || userTheme === "景色") {
      for (let i = 0; i < pairsCount; i++) {
        aiImageUrls.push(`https://picsum.photos/seed/${roomName}_scenery_${i}/200/200`);
      }
    } 
    else if (userTheme === "ロボット") {
      for (let i = 0; i < pairsCount; i++) {
        aiImageUrls.push(`https://robohash.org/robot_${roomName}_${i}?set=set1&size=200x200`);
      }
    } 
    else if (userTheme === "モンスター") {
      for (let i = 0; i < pairsCount; i++) {
        aiImageUrls.push(`https://robohash.org/monster_${roomName}_${i}?set=set2&size=200x200`);
      }
    } 
    else if (userTheme === "人間" || userTheme === "顔") {
      for (let i = 0; i < pairsCount; i++) {
        aiImageUrls.push(`https://robohash.org/human_${roomName}_${i}?set=set5&size=200x200`);
      }
    } 
    else {
      try {
        const prompt = `You are an expert prompt engineer. The user wants to generate ${pairsCount} images based on the theme: "${userTheme}".
        Please provide exactly ${pairsCount} short, highly visual English keywords or phrases.
        Rules:
        - strictly ONLY English.
        - Comma-separated ONLY.
        - NO numbers, NO bullet points, NO extra words.`;
        
        const result = await model.generateContent(prompt);
        const text = await result.response.text();
        
        const cleanText = text.replace(/[\n\*\.0-9]/g, ""); 
        
        const keywords = cleanText.split(',').map((w) => {
          return w.trim();
        }).filter((w) => {
          return w !== "";
        });
        
        while(keywords.length < pairsCount) { 
          keywords.push(userTheme + " " + Math.random()); 
        }

        aiImageUrls = keywords.slice(0, pairsCount).map((word) => {
          return `https://robohash.org/${encodeURIComponent(word)}?set=set4&size=200x200`;
        });

      } catch (error) {
        console.error("AI生成エラー:", error);
        for (let i = 0; i < pairsCount; i++) {
          aiImageUrls.push(`https://robohash.org/fallback_cat_${i}?set=set4&size=200x200`);
        }
      }
    }

    setupCards(room, aiImageUrls, pairsCount);
    
    room.players.forEach((id) => { 
      room.scores[id] = 0; 
    });
    
    room.turnIndex = 0;
    room.cpuMemory = {};

    io.to(roomName).emit('ai_status', "生成完了！ゲームスタート！");
    
    io.to(roomName).emit('game_started'); 
    
    io.to(roomName).emit('update_game', { 
      cards: room.cards, 
      scores: room.scores, 
      currentTurn: room.players[room.turnIndex], 
      players: room.players, 
      theme: room.currentTheme 
    });

  });

  socket.on('flip_card', (cardId) => {
    const roomName = socket.roomName;
    
    if (!roomName) {
      return;
    }
    
    if (!rooms[roomName]) {
      return;
    }
    
    let room = rooms[roomName];

    if (room.gameMode === 'local') {
      if (!room.players[room.turnIndex].startsWith(socket.id)) {
        return;
      }
    } else {
      if (socket.id !== room.players[room.turnIndex]) {
        return;
      }
    }

    const card = room.cards.find((c) => {
      return c.id === cardId;
    });

    if (card.isOpen) {
      return;
    }
    
    if (card.isMatched) {
      return;
    }

    const opened = room.cards.filter((c) => {
      return c.isOpen && !c.isMatched;
    });
    
    if (opened.length >= 2) {
      return;
    }

    room.cpuMemory[card.id] = card.val;
    card.isOpen = true;
    
    io.to(roomName).emit('update_game', { 
      cards: room.cards, 
      scores: room.scores, 
      currentTurn: room.players[room.turnIndex], 
      players: room.players, 
      theme: room.currentTheme 
    });

    const newOpened = room.cards.filter((c) => {
      return c.isOpen && !c.isMatched;
    });

    if (newOpened.length === 2) {
      const card1 = newOpened[0];
      const card2 = newOpened[1];
      
      if (card1.val === card2.val) {
        card1.isMatched = true; 
        card2.isMatched = true;
        
        room.scores[room.players[room.turnIndex]] += 1; 
        
        io.to(roomName).emit('match_result', { 
          msg: "正解！", 
          success: true 
        });
        
        io.to(roomName).emit('update_game', { 
          cards: room.cards, 
          scores: room.scores, 
          currentTurn: room.players[room.turnIndex], 
          players: room.players, 
          theme: room.currentTheme 
        });

        const isGameOver = room.cards.every((c) => {
          return c.isMatched;
        });

        if (isGameOver) {
          checkGameOver(roomName);
        }
      } else {
        io.to(roomName).emit('match_result', { 
          msg: "残念...", 
          success: false 
        });
        
        setTimeout(() => {
          card1.isOpen = false; 
          card2.isOpen = false;
          
          room.turnIndex = (room.turnIndex + 1) % room.players.length;
          
          io.to(roomName).emit('update_game', { 
            cards: room.cards, 
            scores: room.scores, 
            currentTurn: room.players[room.turnIndex], 
            players: room.players, 
            theme: room.currentTheme 
          });

          if (room.players[room.turnIndex] === 'CPU') {
            playCPUTurn(roomName);
          }
        }, 1500); 
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('切断されました。ID:', socket.id);
    const roomName = socket.roomName;
    
    if (roomName && rooms[roomName]) {
      let room = rooms[roomName];
      
      room.players = room.players.filter((id) => {
        return id !== socket.id;
      });
      
      delete room.scores[socket.id];
      
      io.to(roomName).emit('update_game', { 
        cards: room.cards, 
        scores: room.scores, 
        currentTurn: room.players[room.turnIndex], 
        players: room.players, 
        theme: room.currentTheme 
      });

      if (room.players.length === 0) {
        delete rooms[roomName];
        console.log(`部屋[${roomName}] を解体しました`);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`完全版サーバー起動完了！ ポート番号: ${PORT}`);
});