const socketPort = process.env.PORT || 3000;
const webPort = process.env.WEB_PORT || 8080;
const os = require( 'os' );
const networkInterfaces = os.networkInterfaces( );
console.log( networkInterfaces );
console.log(`Server instance started at ${new Date()}`);
const express = require('express');
const app = express();


const io = require('socket.io')(socketPort);
const shortId = require('shortid');
const _ = require('lodash');
const dynamo = require('./dynamo');
const gameUtils = require('./game_utils');

const playerDataMap = {};
const cleanPlayerData = {}; // for sending player list
const socketIdsToUsers = {};
const invitations = {}; // key - inviting player , value - invited player
const invitationsReverse = {};

const playersInInvitePage = [];

const onGoingGames = {};

function intervalFunc() {
    console.log(serverDataToString());

    removeDisconnectedPlayers();
    cleanInviteList();
}

function cleanInviteList() {
    playersInInvitePage.forEach(pName => {
        if (playerDataMap[pName] === undefined) {
            _.remove(playersInInvitePage, p => p === pName);
            return;
        }
        if (playerDataMap[pName].socket.connected === false) {
            _.remove(playersInInvitePage, p => p === pName)
        }
    });
}

function removeDisconnectedPlayers() {
    Object.keys(playerDataMap).forEach(pName=>{
        if (playerDataMap[pName].socket.connected === false) {

            console.log(`${pName} is no longer connected and will be removed from players list`);

            removeUser(pName);
            if (playersInInvitePage.includes(pName)){
                sendPlayerListToAvailablePlayers();
            }
        }
    });
}

function removeUser(pName) {
    delete cleanPlayerData[pName];
    delete socketIdsToUsers[playerDataMap[pName].socket.id];
    delete playerDataMap[pName];
    delete invitations[pName];
    delete invitationsReverse[pName];
    _.remove(playersInInvitePage, p => p === pName)
}

setInterval(intervalFunc, 30000);

console.log("Socket server started on port " + socketPort);

io.on('connection', function (socket) {

    console.log(`New connection, socket id: ${socket.id}`);

    socket.on('disconnect', function() {
        const pName = socketIdsToUsers[socket.id];
        console.log(`client disconnected, socket id: ${socket.id}, username: ${pName}`);

        if (playerDataMap[pName] && playerDataMap[pName].currentGame) {
            console.log(`${pName} disconnected in the middle of a game. notifying opponent`);
            const gameId = playerDataMap[pName].currentGame;

            if (onGoingGames[gameId] !== undefined) {
                const opponent = onGoingGames[gameId].player1 === pName ? onGoingGames[gameId].player2 : onGoingGames[gameId].player1;
                playerDataMap[opponent].socket.emit('game_over', {message: `player opponent has exited`});
                gameOver(gameId, opponent, pName);
            }
            else {
                console.log(`Game ID is undefined`);
            }
        }

        if (pName) {
            removeUser(pName);

            if (playersInInvitePage.includes(pName)) {
                sendPlayerListToAvailablePlayers();
            }
        }
    });

    socket.on('login_or_sign_up', function (data) {
        console.log('client try to login or signup');
        console.log(data);

        if (socketIdsToUsers[socket.id]) {
            console.log(`${data.username} is already logged in as ${socketIdsToUsers[socket.id]}. Logging out ${socketIdsToUsers[socket.id]}`)
            removeUser(socketIdsToUsers[socket.id]);
        }

        if (playerDataMap[data.username]) {
            console.log(`user ${data.username} is already logged in`);
            socket.emit(`login_failed`, {result: 'failed', message: `user ${data.username} is already logged in`});
            return;
        }

        return dynamo.checkUserPassword(data.username, data.password)
            .then(res=>{
                if (res.result === 'success') {
                    console.log(`${data.username} logged in`);
                    addPlayerToPlayersList(res.data, socket);
                    socket.emit(`login_success`, res);
                    return;
                }
                if (res.reason === `user doesn't exist`) {
                    return dynamo.registerNewUser(data.username, data.password)
                        .then((res)=>{
                            if (res.result === `success`) {
                                addPlayerToPlayersList(res.data, socket);
                                socket.emit(`login_success`, res);
                            }
                            else {
                                socket.emit(`signup_failed`, res);
                            }
                        });
                }
                socket.emit(`login_failed`, res);
            })
    });

    socket.on('logout', function () {
        const pName = socketIdsToUsers[socket.id];
        console.log(`player ${pName} trying to log out`);

        if (playersInInvitePage.includes(pName)){
            removeUser(pName);
            sendPlayerListToAvailablePlayers();
        }
        else {
            removeUser(pName);
        }
    });

    socket.on('quit_game', function () {
        const pName = socketIdsToUsers[socket.id];
        console.log(`player ${pName} has quit the game`);

        const gameId = playerDataMap[pName].currentGame;

        if (onGoingGames[gameId] === undefined) {
            console.log(`Game ID is undefined`);
            return;
        }

        const opponent = onGoingGames[gameId].player1 === pName ? onGoingGames[gameId].player2 : onGoingGames[gameId].player1;

        playerDataMap[opponent].socket.emit('game_over', {message: `player opponent has exited`});
        gameOver(gameId, opponent, pName);
    });

    socket.on('exit_invite_screen', function () {
        const pName = socketIdsToUsers[socket.id];
        console.log(`${pName} has exited the invite screen`);
        _.remove(playersInInvitePage, p => p === pName);

        sendPlayerListToAvailablePlayers();
    });

    socket.on('enter_invite_screen', function () {
        const pName = socketIdsToUsers[socket.id];
        console.log(`${pName} has entered the invite screen`);
        playersInInvitePage.push(pName);

        sendPlayerListToAvailablePlayers();
    });

    socket.on('get_players_list', function () {
        console.log('client asking for players list');

        socket.emit(`players_list`, cleanPlayerData)
    });

    socket.on('play', function (data) {
        console.log(`Server logic started at ${(new Date).getTime()} milliseconds`);

        const pName = socketIdsToUsers[socket.id];
        console.log(`player ${pName} trying to make a move`);

        console.log(data);

        if (playerDataMap[pName].currentGame === undefined) {
            socket.emit('move_not_accepted', {message: 'you are not in a game'});
            return;
        }

        const gameId = playerDataMap[pName].currentGame;
        const game = onGoingGames[gameId];
        if (game.currentTurn !== pName) {
            socket.emit('move_not_accepted', {message: 'not your turn'});
            return;
        }

        const board = game.player1 === pName ? game.board2 : game.board1;
        if (!gameUtils.checkMove(data.i, data.j, board)) {
            socket.emit('move_not_accepted', {message: 'illegal move'});
            return;
        }

        console.log(`GAME (${gameId}): Server has received ${pName}'s attempted move: ${data.i}, ${data.j}`);

        const opponent = game.player1 === pName ? game.player2 : game.player1;

        playerDataMap[opponent].socket.emit('enemy_move', {i: data.i, j: data.j});

        console.log(`Server logic finished at ${(new Date).getTime()} milliseconds`);

        socket.emit('move_accepted', {i: data.i, j: data.j});
        game.currentTurn = opponent;
        game.history.push({pName, i: data.i, j: data.j});
        if (gameUtils.checkGameOver(board)) {
            console.log(`GAME (${gameId}): Server has recognized end of game`);
            gameOver(gameId, pName, opponent);
        }
    });

    socket.on('invite_player', function (data) {
        const pName = socketIdsToUsers[socket.id];
        console.log(`${pName} inviting ${data.player} to a game`);

        if (invitations[pName]) {
            socket.emit('invite_failed', {message: 'you have already invited a player to a game'});
            return
        }

        if (Object.values(invitations).includes(data.player)) {
            socket.emit('invite_failed', {message: `${data.player} has already been invited to a game`});
            return
        }

        if (playerDataMap[pName].currentGame) {
            socket.emit('invite_failed', {message: 'you are already in a game'});
            return;
        }

        if (playerDataMap[data.player] === undefined) {
            socket.emit('invite_failed', {message: `invited player doesn't exist`});
            return;
        }

        if (playerDataMap[data.player].currentGame) {
            socket.emit('invite_failed', {message: 'invited player is already in a game'});
            return;
        }

        invitations[pName] = data.player;
        invitationsReverse[data.player] = pName;
        playerDataMap[data.player].socket.emit('game_invite', {player: pName});

        sendPlayerListToAvailablePlayers();
    });

    socket.on('invite_rejected', function (data) {
        const pName = socketIdsToUsers[socket.id];
        const invitingPlayer = invitationsReverse[pName];
        console.log(`${pName} rejected ${invitingPlayer}'s invitation to a game`);
        playerDataMap[invitingPlayer].socket.emit('invite_rejected');

        delete invitationsReverse[pName];
        delete invitations[invitingPlayer];

        sendPlayerListToAvailablePlayers();
    });

    socket.on('invite_accepted', function (data) {
        const player1 = socketIdsToUsers[socket.id];
        const player2 = invitationsReverse[player1];

        console.log(`${player1} has accepted ${player2}'s invitation to a game`);

        startNewGame(player1, player2);
        socket.emit('start_placement');
        playerDataMap[player2].socket.emit('start_placement');

        delete invitationsReverse[player1];
        delete invitations[player2];
        _.remove(playersInInvitePage, p => p === player1 || p === player2);
    });

    socket.on('cancel_invite', function (data) {
        const pName = socketIdsToUsers[socket.id];
        const invitedPlayer = invitations[pName];

        console.log(`Canceling invite: ${pName} has invited ${invitedPlayer}`);

        if (playerDataMap[invitedPlayer]) {
            playerDataMap[invitedPlayer].socket.emit('invite_cancelled');
        }

        delete invitationsReverse[invitedPlayer];
        delete invitations[pName];

        sendPlayerListToAvailablePlayers();
    });

    socket.on('board_placement', function (data) {
        const pName = socketIdsToUsers[socket.id];
        const gameId = playerDataMap[pName].currentGame;

        console.log(`GAME (${gameId}): Server has received ${pName}'s board placement`);

        if (onGoingGames[gameId] === undefined) {
            console.log(`Game ID is undefined`);
            return;
        }

        const isPlayer1 = onGoingGames[gameId].player1 === pName;
        const opponent = isPlayer1 ? onGoingGames[gameId].player2 : onGoingGames[gameId].player1;

        if (isPlayer1) {
            onGoingGames[gameId].board1 = data.board;
        }
        else {
            onGoingGames[gameId].board2 = data.board;
        }

        if (onGoingGames[gameId].board1 && onGoingGames[gameId].board2) {
            console.log(`GAME (${gameId}): starting game`);
            socket.emit('start_game', {board: isPlayer1 ? onGoingGames[gameId].board2 : onGoingGames[gameId].board1});
            playerDataMap[opponent].socket.emit('start_game', {board: isPlayer1 ? onGoingGames[gameId].board1 : onGoingGames[gameId].board2});
            convertBoardsToMatrices(onGoingGames[gameId]);
        }
    });
});

function sendPlayerListToAvailablePlayers() {
    const playersToOmit = [];
    Object.keys(onGoingGames).forEach(gameId=>{
        playersToOmit.push(onGoingGames[gameId].player1);
        playersToOmit.push(onGoingGames[gameId].player2);
    });
    playersToOmit.concat(Object.keys(invitations));
    playersToOmit.concat(Object.keys(invitationsReverse));
    let availablePlayersObj = _.omit(cleanPlayerData, playersToOmit);
    availablePlayersObj = _.pick(cleanPlayerData, playersInInvitePage);
    Object.keys(availablePlayersObj).forEach(pName=>{
        console.log(`Sending list to ${pName} that contains players: ${JSON.stringify(_.omit(availablePlayersObj, [pName]), null, '\t')}`);
        // playerDataMap[pName].socket.emit(`players_list`, availablePlayersObj);
        playerDataMap[pName].socket.emit(`players_list`, _.omit(availablePlayersObj, [pName]));
    })
}

function addPlayerToPlayersList(playerData, socket) {
    playerDataMap[playerData.name] = {
        socket
    };
    cleanPlayerData[playerData.name] = {
        wins: playerData.wins || 0,
        plays: playerData.plays || 0,
        username: playerData.name,
        currentlyPlaying: false
    };
    socketIdsToUsers[socket.id] = playerData.name;
}

function startNewGame(player1, player2) {
    const gameId = shortId.generate();
    playerDataMap[player1].currentGame = gameId;
    playerDataMap[player2].currentGame = gameId;
    cleanPlayerData[player1].currentlyPlaying = true;
    cleanPlayerData[player2].currentlyPlaying = true;
    onGoingGames[gameId] = {
        player1,
        player2,
        history: [],
        currentTurn: player2
    };
}

function gameOver(gameId, winner, loser) {
    cleanPlayerData[winner].wins++;
    cleanPlayerData[winner].plays++;
    cleanPlayerData[winner].currentlyPlaying = false;
    cleanPlayerData[loser].currentlyPlaying = false;
    cleanPlayerData[loser].plays++;
    dynamo.updateUserData(winner, cleanPlayerData[winner].wins, cleanPlayerData[winner].plays);
    dynamo.updateUserData(loser, cleanPlayerData[loser].wins, cleanPlayerData[loser].plays);
    delete onGoingGames[gameId];
}

function convertBoardsToMatrices(gameObj) {
    gameObj.board1 = convertBoardToMatrix(gameObj.board1);
    gameObj.board2 = convertBoardToMatrix(gameObj.board2);
}

function convertBoardToMatrix(boardStr) {
    const boardSize = 10;

    const mat = [];

    boardStr.split(',').forEach((value, index) => {
        const row = Math.floor(index / boardSize);
        mat[row] = mat[row] || [];
        mat[row][index % boardSize] = ['1', '2', '3'].includes(value) ? 1 : 0;
    });

    return mat;
}

function serverDataToString() {
    return `Server is running ${new Date()}\n\nClean player data:
${JSON.stringify(cleanPlayerData, null, '\t')}\n\nOngoing games:
${JSON.stringify(onGoingGames, null, '\t')}\n\nSocket Ids to users:
${JSON.stringify(socketIdsToUsers, null, '\t')}\n\nConnected users:
${Object.keys(playerDataMap)}\n\nPlayers in invite list:
${playersInInvitePage}\n\n`
}

app.get('/', (req, res) => {
    res.send(serverDataToString()
        .replace(/\n/g, '<br>')
        .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;'))
});

app.listen(webPort, () => console.log(`Simple web page running at port ${webPort}!`));
