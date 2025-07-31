import React, { useState, useEffect, useRef, useCallback } from 'react';
import { BrowserRouter as Router, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom';
import { io } from 'socket.io-client';
import { FaCoffee, FaCopy, FaHome, FaShare } from 'react-icons/fa';
import { GiCoffeeBeans, GiCoffeeCup } from 'react-icons/gi';
import { Wheel } from 'react-custom-roulette';
import Confetti from 'react-confetti';
import config from './config';
import './App.css';

// Viewport height calculation
const setViewportHeight = () => {
  const vh = window.innerHeight * 0.01;
  document.documentElement.style.setProperty('--vh', `${vh}px`);
};

// Helper function to generate and store user ID
const getUserId = (roomId, name) => {
  const key = `user_${roomId}_${name}`;
  let userId = localStorage.getItem(key);
  if (!userId) {
    userId = `user_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem(key, userId);
  }
  return userId;
};

// Home Component
function Home() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    setViewportHeight();
    window.addEventListener('resize', setViewportHeight);
    return () => window.removeEventListener('resize', setViewportHeight);
  }, []);

  const handleCreateRoom = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Lütfen isminizi girin');
      return;
    }
    setError('');
    setLoading(true);

    try {
      const res = await fetch(`${config.apiUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerName: name.trim() })
      });
      
      const data = await res.json();
      
      if (!res.ok) {
        if (data.error === 'NAME_TAKEN') {
          setError('Bu isim başka bir oda sahibi tarafından kullanılıyor. Lütfen başka bir isim deneyin.');
        } else {
          setError('Oda oluşturulurken bir hata oluştu. Lütfen tekrar deneyin.');
        }
        return;
      }
      
      // Store room owner access token in localStorage
      localStorage.setItem(`room_owner_${data.roomId}`, data.ownerToken);
      navigate(`/rulet/${data.roomId}`, { 
        state: { 
          name: name.trim(), 
          isOwner: true,
          ownerToken: data.ownerToken 
        } 
      });
    } catch (error) {
      console.error('Error creating room:', error);
      setError('Oda oluşturulurken bir hata oluştu. Lütfen tekrar deneyin.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="App">
      <div className="container">
        <GiCoffeeCup className="coffee-icon" size={50} />
        <h1 className="title">Kahve Ruleti</h1>
        <p className="subtitle">Kim kahve yapacak? Hadi öğrenelim!</p>
        <form onSubmit={handleCreateRoom} className="join-form">
          <div className="input-group">
            <input
              type="text"
              placeholder="İsminiz"
              value={name}
              onChange={e => setName(e.target.value)}
              required
              autoComplete="name"
              maxLength={30}
            />
          </div>
          {error && <div className="error-message">{error}</div>}
          <button type="submit" disabled={loading || !name.trim()}>
            {loading ? 'Oluşturuluyor...' : 'Kahve Ruleti Başlat'} <FaCoffee style={{ marginLeft: '8px' }} />
          </button>
        </form>
      </div>
    </div>
  );
}

// JoinRoom Component
function JoinRoom() {
  // State Management
  const [roomState, setRoomState] = useState({
    name: '',
    joined: false,
    participants: [],
    roomOwner: '',
    error: '',
    expired: false,
    rouletteError: '',
    joinError: '',
    inputName: '',
    winner: null,
    displayedWinner: null,
    copied: false,
    newParticipant: null,
    userId: null
  });

  // Bildirim için ayrı bir state ve ref
  const [notification, setNotification] = useState(null);
  const notificationTimer = useRef(null);

  const [rouletteState, setRouletteState] = useState({
    mustSpin: false,
    prizeNumber: 0,
    isSpinning: false,
    showConfetti: false
  });

  const [windowSize, setWindowSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight
  });

  // Hooks
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const socketRef = useRef(null);
  const winnerRef = useRef(null);

  // Effects
  useEffect(() => {
    setViewportHeight();
    window.addEventListener('resize', setViewportHeight);
    return () => window.removeEventListener('resize', setViewportHeight);
  }, []);

  useEffect(() => {
    if (location.state?.name && !roomState.joined) {
      const isOwner = location.state.isOwner;
      const ownerToken = localStorage.getItem(`room_owner_${roomId}`);
      const userId = getUserId(roomId, location.state.name);
      
      if (isOwner && !ownerToken) {
        setRoomState(prev => ({
          ...prev,
          error: 'Bu odaya erişim yetkiniz yok. Oda sahibi yalnızca ilk girişte erişebilir.'
        }));
        return;
      }
      
      setRoomState(prev => ({
        ...prev,
        name: location.state.name,
        joined: true,
        isOwner: isOwner,
        userId: userId
      }));
    }
  }, [location.state, roomState.joined, roomId]);

  useEffect(() => {
    const fetchRoomData = async () => {
      try {
        const res = await fetch(`${config.apiUrl}/api/rooms/${roomId}`);
        const data = await res.json();
        
        if (data.error) {
          setRoomState(prev => ({ ...prev, error: data.error }));
        } else {
          setRoomState(prev => ({
            ...prev,
            roomOwner: data.owner,
            participants: data.participants
          }));
        }
      } catch (error) {
        console.error('Error fetching room:', error);
        setRoomState(prev => ({
          ...prev,
          error: 'Oda bulunamadı veya bir hata oluştu.'
        }));
      }
    };

    fetchRoomData();
  }, [roomId]);

  // Socket connection setup
  useEffect(() => {
    if (!roomState.joined || !roomState.name) return;

    // Create socket connection only once
    if (!socketRef.current) {
      socketRef.current = io(config.socketUrl, {
        query: { 
          name: roomState.name,
          isOwner: location.state?.isOwner || false,
          ownerToken: localStorage.getItem(`room_owner_${roomId}`),
          userId: roomState.userId
        },
        reconnection: true,
        reconnectionAttempts: 5,
        reconnectionDelay: 1000
      });
    }

    // Join room and request initial participant list
    const joinAndSync = () => {
      socketRef.current.emit('join_room', { 
        roomId, 
        name: roomState.name,
        isOwner: location.state?.isOwner || false,
        ownerToken: localStorage.getItem(`room_owner_${roomId}`),
        userId: roomState.userId
      });
      socketRef.current.emit('request_participants', { roomId });
    };

    joinAndSync();

    // Set up periodic sync every 5 seconds
    const syncInterval = setInterval(() => {
      if (socketRef.current?.connected) {
        socketRef.current.emit('request_participants', { roomId });
      }
    }, 5000);

    return () => {
      clearInterval(syncInterval);
    };
  }, [roomState.joined, roomId, roomState.name, location.state?.isOwner, roomState.userId]);

  // Event handlers with useCallback to prevent stale closures
  const handleParticipantsUpdate = useCallback((list) => {
    console.log('Received participants update:', list);
    
    // Keep participants in original order from server
    setRoomState(prev => {
      const newParticipants = list;
      const oldParticipants = prev.participants;
      
      // Check for new participants
      if (newParticipants.length > oldParticipants.length) {
        const newParticipantsList = newParticipants.filter(
          newP => !oldParticipants.some(
            oldP => oldP.id === newP.id
          )
        );
        
        if (newParticipantsList.length > 0) {
          const lastNewParticipant = newParticipantsList[newParticipantsList.length - 1];
          if (lastNewParticipant.id !== prev.userId) {
            setNotification(lastNewParticipant.name);
            setTimeout(() => setNotification(null), 3000);
          }
        }
      }
      
      return { ...prev, participants: newParticipants };
    });
  }, []);

  const handleStartRoulette = useCallback(() => {
    setRoomState(prev => {
      if (prev.participants.length < 2) {
        return {
          ...prev,
          rouletteError: 'En az 2 katılımcı gerekli'
        };
      }
      
      // Reset states
      setRouletteState(roulettePrev => ({ 
        ...roulettePrev, 
        isSpinning: true,
        mustSpin: false,
        showConfetti: false
      }));
      
      socketRef.current?.emit('start_roulette', { 
        roomId,
        ownerToken: localStorage.getItem(`room_owner_${roomId}`)
      });
      
      return { 
        ...prev, 
        displayedWinner: null,
        rouletteError: ''
      };
    });
  }, [roomId]);

  const handleRouletteResult = useCallback((winner) => {
    // Find winner by ID instead of name
    setRoomState(prev => {
      const winnerIndex = prev.participants.findIndex(p => p.id === winner.id);
      console.log('Winner selection:', {
        receivedWinner: winner,
        foundIndex: winnerIndex,
        allParticipants: prev.participants
      });
      
      if (winnerIndex !== -1) {
        setRouletteState(roulettePrev => ({
          ...roulettePrev,
          prizeNumber: winnerIndex,
          mustSpin: true,
          isSpinning: true,
          showConfetti: false
        }));
      }
      
      return prev;
    });
  }, []);

  const handleReconnect = useCallback(() => {
    socketRef.current.emit('join_room', { 
      roomId, 
      name: roomState.name,
      isOwner: location.state?.isOwner || false,
      ownerToken: localStorage.getItem(`room_owner_${roomId}`),
      userId: roomState.userId
    });
    socketRef.current.emit('request_participants', { roomId });
  }, [roomId, roomState.name, location.state?.isOwner, roomState.userId]);

  const handleRoomExpired = useCallback((data) => {
    // Only set expired state if we're not the owner or if the roulette has actually started
    if (!location.state?.isOwner || data.rouletteStarted) {
      setRoomState(prev => ({ ...prev, expired: true }));
    }
  }, [location.state?.isOwner]);

  // Event listeners setup - re-run when handlers change
  useEffect(() => {
    if (!socketRef.current) return;

    // Remove existing listeners
    socketRef.current.off('participants_update');
    socketRef.current.off('joined');
    socketRef.current.off('connect');
    socketRef.current.off('reconnect');
    socketRef.current.off('join_error');
    socketRef.current.off('roulette_result');
    socketRef.current.off('room_expired');
    socketRef.current.off('roulette_error');
    socketRef.current.off('roulette_start');

    // Add event listeners
    socketRef.current.on('participants_update', handleParticipantsUpdate);
    socketRef.current.on('joined', () => {
      setRoomState(prev => ({ ...prev, joined: true }));
    });
    socketRef.current.on('connect', handleReconnect);
    socketRef.current.on('reconnect', handleReconnect);
    socketRef.current.on('join_error', (data) => setRoomState(prev => ({ ...prev, joinError: data.message })));
    socketRef.current.on('roulette_result', handleRouletteResult);
    socketRef.current.on('room_expired', handleRoomExpired);
    socketRef.current.on('roulette_error', (data) => {
      setRoomState(prev => ({ ...prev, rouletteError: data.message }));
      setRouletteState(prev => ({ ...prev, isSpinning: false }));
    });
    socketRef.current.on('roulette_start', () => {
      setRouletteState(prev => ({ 
        ...prev, 
        isSpinning: true,
        mustSpin: true,
        prizeNumber: 0  // Başlangıç pozisyonu
      }));
    });

    // Cleanup function
    return () => {
      if (socketRef.current) {
        socketRef.current.off('participants_update');
        socketRef.current.off('joined');
        socketRef.current.off('connect');
        socketRef.current.off('reconnect');
        socketRef.current.off('join_error');
        socketRef.current.off('roulette_result');
        socketRef.current.off('room_expired');
        socketRef.current.off('roulette_error');
        socketRef.current.off('roulette_start');
      }
    };
  }, [handleParticipantsUpdate, handleStartRoulette, handleRouletteResult, handleReconnect, handleRoomExpired]);

  // Cleanup socket connection when component unmounts
  useEffect(() => {
    return () => {
      if (socketRef.current) {
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (roomState.winner) {
      const winnerIndex = roomState.participants.findIndex(p => p.name === roomState.winner.name);
      if (winnerIndex !== -1) {
        setRouletteState(prev => ({
          ...prev,
          prizeNumber: winnerIndex,
          mustSpin: true
        }));
      }
    }
  }, [roomState.winner, roomState.participants]);

  useEffect(() => {
    const handleResize = () => {
      setWindowSize({
        width: window.innerWidth,
        height: window.innerHeight
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Bildirim için useEffect
  useEffect(() => {
    let timer;
    if (notification) {
      timer = setTimeout(() => {
        setNotification(null);
      }, 3000);
    }
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [notification]);

  // Handlers
  const handleJoin = (e) => {
    e.preventDefault();
    const trimmedName = roomState.inputName.trim();
    
    if (!trimmedName) {
      setRoomState(prev => ({ ...prev, joinError: 'Lütfen isminizi girin' }));
      return;
    }

    // Check if trying to join as room owner
    if (trimmedName === roomState.roomOwner) {
      setRoomState(prev => ({
        ...prev,
        joinError: 'Bu isim oda sahibine ait. Lütfen başka bir isim seçin.'
      }));
      return;
    }

    // Check if name is already taken by another participant
    const isNameTaken = roomState.participants.some(
      participant => participant.name.toLowerCase() === trimmedName.toLowerCase()
    );

    if (isNameTaken) {
      setRoomState(prev => ({
        ...prev,
        joinError: 'Bu isim zaten kullanılıyor. Lütfen başka bir isim seçin.'
      }));
      return;
    }

    const userId = getUserId(roomId, trimmedName);
    setRoomState(prev => ({
      ...prev,
      joinError: '',
      name: trimmedName,
      joined: true,
      userId: userId
    }));
  };

  const handleCopy = () => {
    const inviteLink = `${window.location.origin}/rulet/${roomId}`;
    navigator.clipboard.writeText(inviteLink);
    setRoomState(prev => ({ ...prev, copied: true }));
    setTimeout(() => setRoomState(prev => ({ ...prev, copied: false })), 1500);
  };

  const handleShare = async () => {
    const inviteLink = `${window.location.origin}/rulet/${roomId}`;
    const shareData = {
      title: 'Kahve Ruleti',
      text: 'Kahve Ruleti odasına katıl!',
      url: inviteLink
    };

    try {
      if (navigator.share) {
        await navigator.share(shareData);
      } else {
        // Fallback to copy if Web Share API is not supported
        handleCopy();
      }
    } catch (err) {
      console.error('Paylaşım sırasında hata oluştu:', err);
      // Fallback to copy on error
      handleCopy();
    }
  };



  const handleFinishRoulette = () => {
    navigate('/');
  };

  // Render Helpers
  const renderError = () => (
    <div className="App">
      <div className="container">
        <div className="error-message">{roomState.error}</div>
        <button onClick={() => navigate('/')}><FaHome /> Ana Sayfa</button>
      </div>
    </div>
  );

  const renderExpired = () => (
    <div className="App">
      <div className="container">
        <div className="error-message">
          Davet linkinin süresi doldu. Rulet başlatıldıktan sonra yeni katılımcı eklenemez.
        </div>
        <button onClick={() => navigate('/')}><FaHome /> Ana Sayfa</button>
      </div>
    </div>
  );

  const renderWinner = () => {
    if (!roomState.displayedWinner || rouletteState.isSpinning) return null;
    const isWinnerHost = roomState.displayedWinner.name.includes('👑');
    return (
      <div className="winner-announcement">
        <p className="winner-text">
          {isWinnerHost ? 
            `${roomState.displayedWinner.name}` : 
            roomState.displayedWinner.name.toUpperCase()
          } kahve yapmakla görevlendirildi! ☕
        </p>
        <button onClick={handleFinishRoulette} className="home-button">
          <FaHome /> Ana Sayfaya Dön
        </button>
      </div>
    );
  };

  if (roomState.error) return renderError();
  if (roomState.expired) return renderExpired();

  const wheelColors = ['#2C1810', '#6F4E37', '#D4A574', '#8B4513'];
  const inviteLink = `${window.location.origin}/rulet/${roomId}`;

  return (
    <div className="App">
      <div className="container">
        {rouletteState.showConfetti && (
          <Confetti
            width={windowSize.width}
            height={windowSize.height}
            recycle={false}
            numberOfPieces={200}
            colors={['#D4A574', '#6F4E37', '#2C1810', '#F5E6D3', '#FFFDD0']}
          />
        )}
        
        <h1 className="title">Kahve Ruleti</h1>

        {notification && (
          <div className="notification" style={{ animation: 'fadeInOut 3s forwards' }}>
            <GiCoffeeCup className="notification-icon" />
            <p>
              {notification === roomState.roomOwner ? 
                `${notification.toUpperCase()} 👑` : 
                notification.toUpperCase()
              } kahve ruletine katıldı!
            </p>
          </div>
        )}

        {!roomState.joined ? (
          <form onSubmit={handleJoin} className="join-form">
            <div className="input-group">
              <input
                type="text"
                placeholder="İsminiz"
                value={roomState.inputName}
                onChange={e => setRoomState(prev => ({ ...prev, inputName: e.target.value }))}
                required
                autoComplete="name"
                maxLength={30}
              />
            </div>
            {roomState.joinError && (
              <div className="error-message">{roomState.joinError}</div>
            )}
            <button type="submit" disabled={!roomState.inputName.trim()}>
              Katıl <FaCoffee />
            </button>
          </form>
        ) : (
          <>
            <div className="roulette-wrapper">
              <div className="roulette-container">
                {roomState.participants.length > 0 && (
                  <Wheel
                    mustStartSpinning={rouletteState.mustSpin}
                    prizeNumber={rouletteState.prizeNumber}
                    data={roomState.participants.map((p, index) => ({
                      id: p.id, // Add ID to wheel data
                      option: p.name === roomState.roomOwner ? `${p.name.toUpperCase()} 👑` : p.name.toUpperCase(),
                      style: { backgroundColor: '#6F4E37', textColor: '#F5E6D3' }
                    }))}
                    backgroundColors={wheelColors}
                    textColors={['#F5E6D3']}
                    fontSize={16}
                    outerBorderColor="#2C1810"
                    outerBorderWidth={3}
                    innerRadius={20}
                    innerBorderColor="#D4A574"
                    innerBorderWidth={2}
                    radiusLineColor="#F5E6D3"
                    radiusLineWidth={1}
                    perpendicularText={true}
                    spinDuration={0.8}
                    startingOptionIndex={0}
                    rotationOffset={-2}
                    disableInitialAnimation={true}
                    dimensions={windowSize.width <= 768 ? 200 : 300}
                    pointerProps={{
                      src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZD0iTTEyIDJMNCAyMGwyMC0xMC0xMC0yeiIgZmlsbD0iI0Q0QTU3NCIvPjwvc3ZnPg==",
                      style: { width: '30px', top: '-15px' }
                    }}
                    onStopSpinning={() => {
                      setRouletteState(prev => ({
                        ...prev,
                        mustSpin: false,
                        isSpinning: false,
                        showConfetti: true
                      }));
                      setTimeout(() => {
                        const winner = roomState.participants[rouletteState.prizeNumber];
                        console.log('Final winner:', {
                          winner,
                          prizeNumber: rouletteState.prizeNumber,
                          allParticipants: roomState.participants
                        });
                        setRoomState(prev => ({
                          ...prev,
                          displayedWinner: {
                            name: winner.name === roomState.roomOwner ? 
                              `${winner.name.toUpperCase()} 👑` : 
                              winner.name.toUpperCase()
                          }
                        }));
                      }, 500);
                    }}
                  />
                )}
              </div>

              {renderWinner()}

              {roomState.name === roomState.roomOwner && !roomState.displayedWinner && (
                <button
                  className="start-roulette-button"
                  onClick={handleStartRoulette}
                  disabled={rouletteState.isSpinning || roomState.participants.length < 2}
                >
                  {rouletteState.isSpinning ? (
                    <>
                      <GiCoffeeBeans className="spinning" />
                      Çevriliyor...
                    </>
                  ) : (
                    <>
                      <GiCoffeeBeans />
                      Ruleti Başlat
                    </>
                  )}
                </button>
              )}

              {roomState.rouletteError && (
                <div className="error-message">{roomState.rouletteError}</div>
              )}

              {!roomState.displayedWinner && !rouletteState.isSpinning && (
                <p className="waiting-text">
                  {roomState.name === roomState.roomOwner
                    ? roomState.participants.length < 2 
                      ? 'En az bir katılımcı daha bekleniyor...'
                      : 'Ruleti başlatabilirsiniz!'
                    : 'Oda sahibinin ruleti başlatması bekleniyor...'}
                </p>
              )}
            </div>

            {!rouletteState.isSpinning && !roomState.displayedWinner && (
              <div className="bottom-controls">
                <div className="invite-link">
                  <input
                    type="text"
                    value={inviteLink}
                    readOnly
                    onClick={e => e.target.select()}
                  />
                  <div className="invite-buttons">
                    <button onClick={handleCopy} className="copy-button">
                      {roomState.copied ? 'Kopyalandı!' : 'Kopyala'} <FaCopy />
                    </button>
                    <button onClick={handleShare} className="share-button">
                      Paylaş <FaShare />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// App Component
function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/rulet/:roomId" element={<JoinRoom />} />
      </Routes>
    </Router>
  );
}

export default App;