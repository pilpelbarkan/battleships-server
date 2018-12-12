
function checkMove(x, y, board) {
    if (x < 0 || y < 0 || x >= board.length || y >= board.length) {
        return false;
    }
    board[x][y] = -1;
    return true;
}

function checkGameOver(board) {
    return !board.some(row => row.some(value => value === 1));
}

module.exports = {
    checkMove,
    checkGameOver,
};
