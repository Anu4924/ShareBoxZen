chrome.action.onClicked.addListener(function(activeTab) {
    var newURL = "chrome://newtab";
    chrome.tabs.create({ url: newURL });

});


chrome.runtime.onInstalled.addListener(function (object) {
 
    chrome.storage.local.get(['enable_note','shortcut_sts', 'favs', 'shortcuts','timeformat'], function(spiderman1233result) {
    	if(!spiderman1233result.enable_note){
            chrome.storage.local.set({enable_note: 'yes'});
        }
        if(!spiderman1233result.timeformat){
    		chrome.storage.local.set({timeformat: '24h'});
    	}
        if(!spiderman1233result.shortcut_sts){
    		chrome.storage.local.set({shortcut_sts: 'Show'});
    	}
        if(!spiderman1233result.favs){
            chrome.storage.local.set({favs: '[]'});
        }
    	if(!spiderman1233result.shortcuts){
    		chrome.storage.local.set({shortcuts: '[]'});
    	}
	});
	
	if(object.reason == "install"){
		 var spiderman1233_pageurl = 'https://coolthemestores.com/spider-man-wallpaper-hd-new-tab/?utm_campaign=ext&utm_medium=newinstall&utm_source=spiderman';
		 chrome.tabs.query({ active: true, lastFocusedWindow: true }, function (tabs) {
			if(tabs.length > 0){
				var tabid = tabs[0].id;
				chrome.tabs.update(tabid, {url: spiderman1233_pageurl});
			}
		});
       
    }
	
	
});

chrome.runtime.onMessage.addListener(function(t, a, o) {
  if (t.topSites) {
      chrome.topSites.get(function(e) {
          o(e);
      });
      return true;
  }
});

chrome.runtime.setUninstallURL("https://coolthemestores.com/uninstall/?utm_campaign=ext&utm_medium=uninstall&utm_source=spiderman");



