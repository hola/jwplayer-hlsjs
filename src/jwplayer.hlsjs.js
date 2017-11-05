'use strict';
var EventEmitter = require('eventemitter3');
var E = module.exports = HlsProv;
var provider_attached = false;
// jwplayer v8+ dropped exposing jwplayer.events
var jwe = {
    JWPLAYER_MEDIA_BEFORECOMPLETE: 'beforeComplete',
    JWPLAYER_MEDIA_BUFFER: 'bufferChange',
    JWPLAYER_MEDIA_BUFFER_FULL: 'bufferFull',
    JWPLAYER_MEDIA_COMPLETE: 'complete',
    JWPLAYER_MEDIA_ERROR: 'mediaError',
    JWPLAYER_MEDIA_LEVELS: 'levels',
    JWPLAYER_MEDIA_LEVEL_CHANGED: 'levelsChanged',
    JWPLAYER_MEDIA_META: 'meta',
    JWPLAYER_MEDIA_SEEK: 'seek',
    JWPLAYER_MEDIA_SEEKED: 'seeked',
    JWPLAYER_MEDIA_TIME: 'time',
    JWPLAYER_MEDIA_TYPE: 'mediaType',
    JWPLAYER_PLAYER_STATE: 'state',
    JWPLAYER_PROVIDER_FIRST_FRAME: 'providerFirstFrame',
};

// XXX arik: protect against exceptions in api. currently jwplayer will be
// stuck + add test
function HlsProv(id){
    var jwplayer = E.jwplayer||window.jwplayer, Hls = E.Hls||window.Hls;
    var jw = id && jwplayer(id);
    console.log('init hola/hls provider v'+E.VERSION+' hls v'+Hls.version+
        (E.version ? ' hap v'+E.version : ''));
    jw.provider = this;
    function empty_fn(name){ return function(){}; }
    var _this = this;
    this.hls_restore_pos = function(){
        var new_pos = this.hls_queued.seek;
        var old_pos = video.currentTime;
        if (hls.streamController.state == 'STOPPED')
        {
            // XXX pavelki: hack to use our start position
            hls.streamController.startPosition = 0;
            hls.startLoad(new_pos||0);
        }
        if (!new_pos)
            return;
        this._in_seek = true;
        video.currentTime = new_pos;
        this.trigger(jwe.JWPLAYER_MEDIA_SEEK, {position: old_pos,
            offset: new_pos});
        // XXX pavelki: hack to override W3 algorithm of media
        // seeking: when video element has HAVE_NOTHING state,
        // seeking event doesn't fire and loading doesn't start
        if (!video.readyState)
            video.dispatchEvent(new Event('seeking'));
        this.hls_queued.seek = 0;
    };
    function check_playback_started(video){
        if (video.paused)
            return void hls_log('video play refused');
        function rm_listeners(){
            video.removeEventListener('playing', listener);
            video.removeEventListener('pause', listener);
            video.removeEventListener('abort', listener);
            video.removeEventListener('error', listener);
        }
        function listener(e){
            rm_listeners();
            if (e.type!='playing')
                hls_log('play() was interrupted by a "'+e.type+'" event');
        }
        video.addEventListener('playing', listener);
        video.addEventListener('abort', listener);
        video.addEventListener('error', listener);
        video.addEventListener('pause', listener);
    }
    function video_play(){
        var promise = video.play()||check_playback_started(video);
        if (promise && promise.catch)
        {
            promise.catch(function(err){
                hls_log('video_play failed with '+err);
                console.warn(err);
                // user gesture required to start playback
                if (err.name=='NotAllowedError' &&
                    video.hasAttribute('jw-gesture-required'))
                {
                    _this.trigger('autoplayFailed');
                    video.setAttribute('autoplay-failed', 'failed');
                }
            });
        }
        else if (video.hasAttribute('jw-gesture-required'))
        {
            // autoplay isn't supported in older versions of Safari (<10)
            // and Chrome (<53)
            _this.trigger('autoplayFailed');
            video.setAttribute('autoplay-failed', 'failed');
        }
    }
    function hls_log(msg){
        var dbg;
        if (dbg = hls_params.debug)
            dbg.log(msg);
    }
    function hls_play(){
        hls_log('hls_play state: '+_this.hls_state+' att:'+_this.attached);
        if (!(_this.hls_queued.play = _this.hls_state!='ready') &&
            _this.attached)
        {
            _this.hls_restore_pos();
            video_play();
        }
    }
    function hls_load(src){
        if (!src)
            return;
        if (_this.hls_state=='ready')
            _this.hls_state = 'idle';
        if (_this.level_cb)
            hls.off(Hls.Events.LEVEL_LOADED, _this.level_cb);
        _this.level_cb = function(){
            hls_log('hls play queued on level_cb:'+_this.hls_queued.play);
            hls.off(Hls.Events.LEVEL_LOADED, _this.level_cb);
            _this.level_cb = undefined;
            _this.hls_state = 'ready';
            if (_this.hls_queued.play)
                hls_play();
            _this.trigger(jwe.JWPLAYER_MEDIA_BUFFER_FULL);
        };
        hls.on(Hls.Events.LEVEL_LOADED, _this.level_cb);
        hls.loadSource(src);
        if (!hls.media)
            _this.attachMedia();
    }
    function on_video_src_change(video, allow_cb){
        var o = video;
        for (; o && !o.hasOwnProperty('src'); o = Object.getPrototypeOf(o));
        if (!o)
            return;
        var prop = Object.getOwnPropertyDescriptor(o, 'src');
        // XXX volodymyr: some browsers (e.g. safari9) may lock access to src,
        // solution copied from polyfill.video_source_access in html5.js
        if (!prop.get && !prop.set)
        {
            prop.get = function(){
                var src = video.getAttribute('src');
                return src!=null ? src : '';
            };
            prop.set = function(s){
                var el = document.createElement('source');
                el.src = s||''; // will convert relative path into absolute uri
                video.setAttribute('src', el.src);
            };
        }
        Object.defineProperty(video, 'src', {
            configurable: true,
            enumerable: false,
            set: function(src){
                if (allow_cb(prop.get.call(video), src))
                    prop.set.call(video, src);
            },
            get: prop.get,
        });
    }
    function get_default_src(sources){
        return sources &&
            sources.find(function(s){ return s.default; }) || sources[0];
    }
    function _log(method, message){
        if (_this.hls.holaLog && _this.hls.holaLog[method])
            _this.hls.holaLog[method].call(_this.hls.holaLog, message);
    }
    // XXX marka: jwplayer inherits provider from DefaultProvider, so it will
    // override our inheritance from EventEmitter, do it manually
    this.events = new EventEmitter();
    this.addEventListener = this.on = this.events.on.bind(this.events);
    this.once = this.events.once.bind(this.events);
    this.removeEventListener = this.off = this.events.off.bind(this.events);
    this.trigger = this.emit = function(e){
        if (!_this.attached && !_this.before_complete)
            return;
        var args = [].slice.call(arguments);
        _this.events.emit.apply(this.events, args);
        if (e!='all')
        {
            args.unshift('all');
            _this.events.emit.apply(this.events, args);
        }
    };
    this.removeAllListeners = function(e){
        this.events.removeAllListeners(e); };
    this.hls_queued = {play: false, seek: 0};
    this.attached = true;
    this.hls_state = 'idle';
    this.is_mobile = function(){
        var ios, and, ua = navigator.userAgent;
        if ((ios = /iP(hone|ad|od)/i.test(ua)) || (and = /Android/i.test(ua)))
            return {is_ios: ios, is_android: and};
    };
    this.supports_captions = function(){
        var ua = navigator.userAgent;
        return /(iPhone|iPad|iPod|iPod touch);.*?OS/.test(ua)
            || / (Chrome|Version)\/\d+(\.\d+)+.* Safari\/\d+(\.\d+)+/.test(ua)
            || /Firefox\/(\d+(?:\.\d+)+)/.test(ua);
    };
    var element = document.getElementById(id), container;
    var video = element ? element.querySelector('video') : undefined, hls;
    var try_play, can_play, _is_mobile = this.is_mobile();
    var visual_quality = {reason: 'initial choice', mode: 'auto'};
    if (!video)
    {
        video = document.createElement('video');
        if (_is_mobile)
            video.setAttribute('jw-gesture-required', '');
    }
    video.className = 'jw-video jw-reset';
    // XXX marka: mark html5 element to skip autodetection of dm/hls
    video.hola_dm_hls_attached = true;
    // XXX pavelki: hack to override ozee's wrong src set
    on_video_src_change(video, function(from, to){ return to!=from+'?'; });
    var hls_params = E.hls_params||{}, hola_log;
    this.ad_count = 0;
    if (jw)
    {
        jw.on('captionsList', caption_track);
        jw.on('captionsChanged', caption_track);
        // XXX pavelki: counters for ad, need to make loading deferred
        jw.on('adImpression', function(){
            _this.ad_count++;
        });
        jw.on('adComplete', function(){ _this.ad_count--; });
        jw.on('adSkipped', function(){ _this.ad_count--; });
        Object.assign(hls_params, jw.hola_config);
        if (hls_params.debug!='undefined')
        {
            hola_log = hls_params.debug;
            delete hls_params.debug;
        }
    }
    hls_params.debug = {};
    ['debug', 'info', 'log', 'warn','error'].forEach(function(method){
        hls_params.debug[method] = _log.bind(null, method); });
    this.hls = hls = new Hls(hls_params);
    hls.holaLog = hola_log;
    if (jw)
        jw.hls = hls;
    var _buffered, _duration, _position;
    function caption_track(cc){
        if (!_this.renderNatively)
            return;
        var tracks = video.textTracks, new_id = cc.tracks[cc.track].id;
        for (var i=0; i<tracks.length; i++)
            tracks[i].mode = tracks[i]._id==new_id ? 'showing' : 'hidden';
    }
    function get_seekable_end(){
        var i, end, len = video.seekable ? video.seekable.length : 0;
        for (end = 0, i = 0; i<len; i++)
            end = Math.max(end, video.seekable.end(i));
        return end;
    }
    function get_duration(){
        var duration = video.duration, end = get_seekable_end();
        if (duration==Infinity && end)
        {
            var seekable_dur = end-video.seekable.start(0);
            if (seekable_dur!=Infinity && seekable_dur>120)
                duration = -seekable_dur;
        }
        return duration;
    }
    function get_duration_inf(){
        return is_live() ? 1/0 : get_duration();
    }
    function is_live(){
        var live, levels;
        try {
            if (!(levels = hls.streamController.levels))
                return;
            var loaded_lvl = levels.find(function(lvl){ return lvl.details; });
            live = loaded_lvl && !!loaded_lvl.details.live;
        } catch(e){ hls_log('is_live failed with '+e); }
        return live;
    }
    function get_buffered(){
        var buf = video.buffered, dur = video.duration;
        if (!buf || !buf.length || dur<=0 || dur==Infinity)
            return 0;
        return Math.min(buf.end(buf.length-1)/dur, 1.0);
    }
    function set_buffered(buffered, pos, duration){
        if (buffered==_buffered && duration==_duration)
            return;
        _buffered = buffered;
        _this.trigger(jwe.JWPLAYER_MEDIA_BUFFER, {bufferPercent: buffered*100,
            position: pos, duration: get_duration_inf()});
    }
    function playback_complete(){
        _this.setState('complete');
        _this.trigger(jwe.JWPLAYER_MEDIA_COMPLETE);
        _this.before_complete = false;
    }
    var video_listeners = {
        durationchange: function(){
            _duration = get_duration();
            set_buffered(get_buffered(), _position, _duration);
        },
        ended: function(){
            if (_this.state=='idle' || _this.state=='complete')
                return;
            _this.before_complete = true;
            _this.trigger(jwe.JWPLAYER_MEDIA_BEFORECOMPLETE);
            if (_this.attached)
                playback_complete();
        },
        error: function(){
            _this.trigger(jwe.JWPLAYER_MEDIA_ERROR, {
                message: 'Error loading media: File could not be played'});
        },
        loadstart: function(){ video.setAttribute('jw-loaded', 'started'); },
        loadeddata: function(){
            video.setAttribute('jw-loaded', 'data');
            if (!_this.supports_captions())
                return;
            video.textTracks.onaddtrack = function(){
                _this.renderNatively = true;
                _this.trigger('subtitlesTracks', {tracks: video.textTracks});
            };
            // XXX pavelki: add checking of playlist
            if (video.textTracks.length)
                video.textTracks.onaddtrack();
        },
        loadedmetadata: function(){
            if (video.muted)
            {
                video.muted = false;
                video.muted = true;
            }
            video.setAttribute('jw-loaded', 'meta');
            _duration = get_duration();
            _this.trigger(jwe.JWPLAYER_MEDIA_META, {duration:
                get_duration_inf(), height: video.videoHeight,
                width: video.videoWidth});
        },
        canplay: function(){
            can_play = true;
            _this.trigger(jwe.JWPLAYER_MEDIA_BUFFER_FULL);
        },
        playing: function(){
            _this.setState('playing');
            if (!video.hasAttribute('jw-played'))
                video.setAttribute('jw-played', '');
            if (video.hasAttribute('jw-gesture-required'))
            {
                video.removeAttribute('jw-gesture-required');
                video.removeAttribute('autoplay-failed');
            }
            _this.trigger(jwe.JWPLAYER_PROVIDER_FIRST_FRAME, {});
        },
        pause: function(){
            if (_this.state=='complete' || video.currentTime==video.duration)
                return;
            _this.setState('paused');
        },
        seeking: function(){
            if (!_this._in_seek)
            {
                _this._in_seek = true;
                _this.trigger(jwe.JWPLAYER_MEDIA_SEEK, {position: _position,
                    offset: video.currentTime});
            }
        },
        seeked: function(){
            _this._in_seek = false;
            _this.trigger(jwe.JWPLAYER_MEDIA_SEEKED);
        },
        progress: function(){
            set_buffered(get_buffered(), _position, _duration); },
        timeupdate: function(){
            _duration = get_duration();
            _position = _duration<0 ? -(get_seekable_end()-video.currentTime) :
                video.currentTime;
            set_buffered(get_buffered(), _position, _duration);
            if (_this.state=='playing')
            {
                _this.trigger(jwe.JWPLAYER_MEDIA_TIME, {position: _position,
                    duration: get_duration_inf()});
            }
        },
    };
    function wrap_gen(e){
        return function(){
            if (!_this.attached)
                return;
            video_listeners[e]();
        };
    }
    for (var e in video_listeners)
        video.addEventListener(e, wrap_gen(e), false);
    function scaled_number(num){
        if (num===undefined)
            return '';
        if (!num)
            return '0';
        var k = 1024;
        var sizes = ['', 'K', 'M', 'G', 'T', 'P'];
        var i = Math.floor(Math.log(num)/Math.log(k));
        num /= Math.pow(k, i);
        if (num<0.001)
            return '0';
        if (num>=k-1)
            num = Math.trunc(num);
        var str = num.toFixed(num<1 ? 3 : num<10 ? 2 : num<100 ? 1 : 0);
        return str.replace(/\.0*$/, '')+sizes[i];
    }
    // XXX yurij: duplicate from videojs5-hlsjs to avoid deps
    function level_label(level){
        if (level.height)
            return level.height+'p';
        if (level.width)
            return Math.round(level.width*9/16)+'p';
        if (level.bitrate)
            return scaled_number(level.bitrate)+'bps';
        return 0;
    }
    function get_levels(){
        var levels = hls.levels||[], res = [];
        // level 0 mimics native jw's hls provider behavior
        if (levels.length>1)
            res.push({label: 'Auto'});
        levels.forEach(function(level){
            res.push({bitrate: level.bitrate, height: level.height,
                label: level_label(level), width: level.width});
        });
        return res;
    }
    function get_level(level){
        var levels = hls.levels||[];
        level = level||hls.currentLevel;
        return {
            // level 0 is dummy for 'Auto' option in jwplayer's UI
            jw: hls.manual_level==-1 || levels.length<2 ? 0 : level+1,
            real: levels.length<2 ? 0 : level+1,
        };
    }
    hls.on(Hls.Events.ERROR, function(event, data){
        if (!data.fatal)
            return;
        var msg;
        switch (data.details)
        {
        case Hls.ErrorDetails.MANIFEST_LOAD_ERROR:
        case Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT:
            msg = 'Cannot load M3U8: '+data.response.statusText;
            break;
        default:
            msg = 'Error loading media: '+data.details;
            break;
        }
        _this.trigger(jwe.JWPLAYER_MEDIA_ERROR, {message: msg});
    });
    hls.on(Hls.Events.MANIFEST_LOADED, function(){
        _this.trigger(jwe.JWPLAYER_MEDIA_LEVELS, {
            currentQuality: get_level().jw,
            levels: get_levels()
        });
        var levels, is_video = 0;
        if (!(levels = hls.levels))
            return;
        levels.forEach(function(level){
            is_video += +!!(level.videoCodec || !level.audioCodec &&
                (level.bitrate>64000 || level.width || level.height));
        });
        _this.trigger(jwe.JWPLAYER_MEDIA_TYPE, {mediaType: is_video ?
            'video' : 'audio'});
    });
    hls.on(Hls.Events.LEVEL_SWITCH, function(e, data){
        var levels = get_levels(), level_id = get_level(data.level);
        _this.trigger(jwe.JWPLAYER_MEDIA_LEVEL_CHANGED, {
            currentQuality: level_id.jw,
            levels: levels,
        });
        var level = levels[level_id.real];
        visual_quality.level = level;
        visual_quality.level.index = level_id.real;
        visual_quality.level.label = hls.manual_level==-1 && levels.length>1 ?
            'auto' : level.label;
        visual_quality.reason = visual_quality.reason||'auto';
        _this.trigger('visualQuality', visual_quality);
        visual_quality.reason = '';
    });
    this.init = function(item){
        try_play = false;
        video.setAttribute('jw-loaded', 'init');
    };
    this.load = function(item){
        if (!this.attached)
            return;
        var newsource = get_default_src(item.sources).file;
        var video_state = video.getAttribute('jw-loaded');
        var hq = this.hls_queued, played = video.hasAttribute('jw-played');
        if (!_is_mobile || played)
        {
            // don't change state on mobile before user initiates playback
            this.setState('loading');
        }
        hq.seek = Math.max(item.starttime-(hq.rw_sec||0), 0);
        if (this.hls_state!='ready' || (this.source||'') != newsource ||
            ['init', 'started'].includes(video_state))
        {
            var sc;
            try_play = false;
            video.load();
            hls.stopLoad(hls.media && this.hls_state=='ready' &&
                video_state=='init');
            hls_load(this.source = newsource);
            video.setAttribute('jw-loaded', 'init');
        }
        else
            hls_play();
        if (_is_mobile && !played)
        {
            if (!try_play && (!_is_mobile.is_ios || can_play))
            {
                try_play = true;
                can_play = false;
                video_play();
            }
            if (!video.paused && this.state!='playing')
                this.setState('loading');
        }
    };
    this.play = function(){ hls_play(); };
    this.pause = function(){
        video.pause();
        _this.setState('paused');
    };
    this.stop = function(){
        hls.stopLoad();
        _this.setState('idle');
    };
    this.volume = function(vol){ video.volume = Math.min(vol/100, 1.0); };
    this.mute = function(state){ video.muted = !!state; };
    this.seek = function(pos){
        this._in_seek = true;
        if (this.hls_state=='ready')
        {
            var sv = video.currentTime;
            video.currentTime = pos;
            this.trigger(jwe.JWPLAYER_MEDIA_SEEK, {position: sv, offset: pos});
        }
        else
            this.hls_queued.seek = pos;
    };
    // XXX arik: todo, without it video resize will be wrong.
    // eg. http://www.ozee.com/shows/muddha-mandaram#hola_mode=cdn&hola_zone=ozee_hap
    this.resize = function(width, height, stretching){};
    this.remove = function(){
        this.in_container = false;
        hls.stopLoad();
        this.source = undefined;
        if (container === video.parentNode)
            container.removeChild(video);
    };
    this.destroy = function(){
        for (var e in video_listeners)
            video.removeEventListener(e, video_listeners[e], false);
        this.removeAllListeners();
    };
    this.setVisibility = function(state){
        container.style.visibility = state ? 'visible' : '';
        container.style.opacity = state ? 1 : 0;
    };
    this.setFullscreen = function(){ return false; };
    this.getFullscreen = empty_fn('getFullscreen');
    this.getContainer = function(){ return container; };
    this.setContainer = function(element){
        container = element;
        container.appendChild(video);
        this.in_container = true;
    };
    hls.manual_level = -1;
    this.setCurrentQuality = function(level){
        if (level == hls.manual_level+1)
            return;
        hls.manual_level = level-1;
        if (!hls.hola_adaptive)
            hls.loadLevel = hls.manual_level;
        _this.trigger(jwe.JWPLAYER_MEDIA_LEVEL_CHANGED,
            {currentQuality: level, levels: get_levels()});
        visual_quality.reason = 'api';
    };
    this.getName = function(){ return {name: 'hola/hls'}; };
    this.get_position = function(){ return video.currentTime; };
    this.getQualityLevels = function(){ return get_levels(); };
    this.getCurrentQuality = function(){ return get_level(hls.loadLevel).jw; };
    this.getAudioTracks = empty_fn('getAudioTracks');
    this.getCurrentAudioTrack = empty_fn('getCurrentAudioTrack');
    this.setCurrentAudioTrack = empty_fn('setCurrentAudioTrack');
    this.checkComplete = function(){ return !!this.before_complete; };
    this.setControls = empty_fn('setControls');
    this.attachMedia = function(){
        if (this.before_complete)
            return playback_complete();
        if (this.ad_count)
            hls_log('jwprovider attach inside ad '+this.ad_count);
        this.attached = true;
        hls.attachMedia(video);
    };
    this.detachMedia = function(){
        hls.trigger(Hls.Events.BUFFER_RESET);
        hls.detachMedia();
        if (this.level_cb)
        {
            hls.off(Hls.Events.LEVEL_LOADED, this.level_cb);
            this.level_cb = undefined;
        }
        // XXX pavelki: hack to remove pending segments
        delete hls.bufferController.segments;
        this.attached = false;
        return video;
    };
    this.setState = function(state){
        var oldState = this.state||'idle';
        this.state = state;
        if (state==oldState)
            return;
        this.trigger(jwe.JWPLAYER_PLAYER_STATE, {newstate: state});
    };
    this.sendMediaType = function(levels){
        var is_audio = ['oga', 'aac', 'mp3', 'mpeg', 'vorbis']
            .includes(levels[0].type);
        this.trigger(jwe.JWPLAYER_MEDIA_TYPE, {mediaType: is_audio ?
            'audio' : 'video'});
    };
}

E.getName = function(){ return {name: 'hola/hls'}; };

// XXX yurij: copied from zjwplayer3.js to not depend on our code
function get_player_instances(){
    var jwplayer = E.jwplayer||window.jwplayer;
    var i = 0, res = [], jw;
    // XXX marka/vadiml: a real instance will contain pause(), otherwise it
    // will be {registerPlugin: ...} with anything the customer adds
    while ((jw = jwplayer(i++)) && jw.pause)
        res.push(jw);
    return res;
}

function src_supported(src){
    if (src.type=='hls')
        return true;
    return (src.file||'').match(/\.m3u8$/);
}

E.supports = function(src){
    var Hls = E.Hls||window.Hls;
    var is_ad = get_player_instances().every(function(j){
        // XXX yurij: jw.getPlaylist returns playlist item on early call
        var pl = j.getPlaylist();
        return (pl.every ? pl : [{sources: [pl]}]).every(function(p){
            // XXX pavlo: playlist item can be w/o sources/allSources
            return (p.allSources||p.sources||[{file: p.file}])
                .every(function(s){ return s.file!=src.file; });
        });
    });
    if (is_ad) // XXX yurij: we are not supporting adaptive ads
        return false;
    return !E.disabled && src_supported(src) && Hls && Hls.isSupported();
};

E.attach = function(){
    var jwplayer = E.jwplayer||window.jwplayer;
    E.disabled = false;
    if (!provider_attached)
    {
        provider_attached = true;
        // XXX arik: unregister on error/fallback
        jwplayer.api.registerProvider(this);
    }
};

E.detach = function(hp){
    // we don't remove provider from list, just set it as disabled so it will
    // return false in supports()
    E.disabled = true;
    if (!hp || !hp.attached)
        return;
    hp.setState('idle');
    hp.detachMedia();
};

// XXX vadiml copied from loader.js&zjwplayer3.js to not depend on our code.
// For use by HolaCDN Onboarding Tool extension
E.reload_jwplayer_instances = function(){
    get_player_instances().forEach(function(jw){
        var c = jw.getConfig();
        if (!c)
            return;
        // XXX marka: JW removes conf.advertising.client, try to restore it
        if (c.advertising && !c.advertising.client && c.plugins)
        {
            for (var url in c.plugins)
            {
                if (c.plugins[url]!==c.advertising)
                    continue;
                var m = url.match(/\/(\w+)\.js$/);
                c.advertising.client = m && m[1];
                break;
            }
        }
        jw.setup(c);
    });
};

E.VERSION = '__VERSION__';
